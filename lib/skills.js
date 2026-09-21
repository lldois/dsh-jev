/**
 * Jev Skill Discovery for DeepSeek Harness (DSH).
 * Semantically matches and suggests specialized agent skills (SKILL.md) for any task.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const JEV_THRESHOLD = 0.65;
export const JEV_FALLBACK_THRESHOLD = 0.20;

/**
 * Scan filesystem roots for available skills if ctx.skills is not yet populated.
 * @returns {Array<{ name: string, description: string, location?: string, provider: string }>}
 */
export function scanFilesystemSkills(cwd) {
  const skills = new Map();
  const searchDirs = [
    path.join(os.homedir(), ".codex", "skills"),
    path.join(os.homedir(), ".dsh", "skills-management"),
  ];
  if (cwd) {
    searchDirs.push(path.join(cwd, ".agents", "skills"));
    searchDirs.push(path.join(cwd, ".skills"));
  }

  for (const baseDir of searchDirs) {
    if (!fs.existsSync(baseDir)) continue;
    try {
      const entries = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMd = path.join(baseDir, entry.name, "SKILL.md");
        if (fs.existsSync(skillMd)) {
          try {
            const raw = fs.readFileSync(skillMd, "utf8");
            let desc = "";
            const descMatch = raw.match(/description:\s*>?\s*([^\n]+(?:\n\s+[^\n]+)*)/i);
            if (descMatch) {
              desc = descMatch[1].replace(/\s+/g, " ").trim();
            } else {
              desc = `Skill for ${entry.name}`;
            }
            if (!skills.has(entry.name)) {
              skills.set(entry.name, {
                name: entry.name,
                description: desc,
                location: skillMd,
                provider: "filesystem",
              });
            }
          } catch {}
        }
      }
    } catch {}
  }

  return Array.from(skills.values());
}

/**
 * Discover available skills in the current DSH context.
 * @param {object} ctx - Cordis context
 * @param {object} [agent] - DSH Agent
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{ name: string, description: string, location?: string, provider?: string }>>}
 */
export async function getAvailableSkills(ctx, agent, signal) {
  const skillsMap = new Map();
  const cwd = agent?.session?.header?.cwd || process.cwd();

  // 1. Query official DSH skills service if available
  const skillsService = ctx.get ? ctx.get("skills") : ctx.skills;
  if (skillsService && typeof skillsService.list === "function") {
    try {
      const lookup = { cwd, signal, scope: agent };
      const list = await skillsService.list(lookup);
      if (Array.isArray(list)) {
        for (const s of list) {
          if (s.name && s.description) {
            skillsMap.set(s.name, {
              name: s.name,
              description: s.description,
              ...(s.resourceBase?.path || s.location ? { location: s.resourceBase?.path || s.location } : {}),
              provider: s.provider || "dsh-skill",
            });
          }
        }
      }
    } catch {}
  }

  // 2. Supplement with filesystem skills
  const fsSkills = scanFilesystemSkills(cwd);
  for (const s of fsSkills) {
    if (!skillsMap.has(s.name)) {
      skillsMap.set(s.name, s);
    }
  }

  return Array.from(skillsMap.values());
}

/**
 * Heuristically shortlist candidate skills for a query.
 * @param {Array<{ name: string, description: string }>} skills
 * @param {string} query
 * @param {number} [limit=12]
 * @returns {Array<{ name: string, description: string }>}
 */
export function shortlistSkills(skills, query, limit = 12) {
  const terms = (query || "").toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean);
  if (terms.length === 0) {
    return skills.slice(0, limit);
  }

  const scored = skills.map((skill) => {
    const text = `${skill.name} ${skill.description || ""}`.toLowerCase();
    let matchCount = 0;
    for (const term of terms) {
      if (text.includes(term)) matchCount += 1;
    }
    return { skill, score: matchCount };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.skill);
}

/**
 * Find and rank matching skills using TypeSafe Jev System One evaluation.
 * @param {object} params
 * @param {string} params.query
 * @param {number} [params.threshold=JEV_THRESHOLD]
 * @param {object} params.ctx
 * @param {object} [params.agent]
 * @param {object} params.jevClient
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ query: string, threshold: number, candidates: string[], recommended: Array<{ name: string, description: string, probability: number, location?: string, lowConfidence?: boolean }>, isLowConfidence: boolean, fallbackUsed: boolean, message?: string, elapsedMs: number }>}
 */
export async function findSkills({
  query,
  threshold = JEV_THRESHOLD,
  ctx,
  agent,
  jevClient,
  signal,
}) {
  const startTime = Date.now();
  const allSkills = await getAvailableSkills(ctx, agent, signal);
  const candidates = shortlistSkills(allSkills, query, 12);
  const candidateNames = candidates.map((c) => c.name);

  if (candidates.length === 0) {
    return {
      query: query || "",
      threshold,
      candidates: [],
      recommended: [],
      isLowConfidence: false,
      fallbackUsed: false,
      elapsedMs: Date.now() - startTime,
    };
  }

  const trimmed = (query || "").trim();
  if (!trimmed) {
    return {
      query: "",
      threshold,
      candidates: candidateNames,
      recommended: [],
      isLowConfidence: false,
      fallbackUsed: false,
      message: `No search query specified. Registered skills in session: ${candidateNames.join(", ")}`,
      elapsedMs: Date.now() - startTime,
    };
  }

  const recommended = [];
  let isLowConfidence = false;
  let fallbackUsed = false;

  if (jevClient && jevClient.isConfigured()) {
    try {
      const questions = {};
      for (const s of candidates) {
        questions[s.name] = {
          type: "noul",
          instructions: `Does the skill '${s.name}' (${s.description}) provide direct guidance or specialized domain steps for this task: "${trimmed}"?`,
        };
      }

      const res = await jevClient.evaluate({
        state: { task: trimmed, available_skills: candidates.map((c) => ({ name: c.name, description: c.description })) },
        questions,
      }, signal);

      const evaluated = [];
      for (const s of candidates) {
        const ans = res.answers[s.name];
        const prob = typeof ans?.value === "number" ? ans.value : 0;
        evaluated.push({
          name: s.name,
          description: s.description,
          ...(s.location ? { location: s.location } : {}),
          probability: prob,
        });
      }

      evaluated.sort((a, b) => b.probability - a.probability);

      for (const s of evaluated) {
        if (s.probability >= threshold) {
          recommended.push(s);
        }
      }

      // Graceful secondary fallback when no candidates meet primary threshold
      if (recommended.length === 0 && evaluated.length > 0) {
        const topCandidates = evaluated.filter((s) => s.probability >= (threshold > 0.3 ? JEV_FALLBACK_THRESHOLD : 0.1));
        if (topCandidates.length > 0) {
          isLowConfidence = true;
          for (const s of topCandidates.slice(0, 2)) {
            recommended.push({
              ...s,
              lowConfidence: true,
            });
          }
        }
      }
    } catch {
      fallbackUsed = true;
    }
  } else {
    fallbackUsed = true;
  }

  if (fallbackUsed) {
    for (const c of candidates.slice(0, 3)) {
      recommended.push({
        name: c.name,
        description: c.description,
        ...(c.location ? { location: c.location } : {}),
        probability: 1.0,
      });
    }
  }

  return {
    query: trimmed,
    threshold,
    candidates: candidateNames,
    recommended,
    isLowConfidence,
    fallbackUsed,
    elapsedMs: Date.now() - startTime,
  };
}
