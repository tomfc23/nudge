/**
 * Idle classification: is a turn-end the agent asking the user something
 * (question) or simply finishing (finished)? See SPEC.md §6.1.
 *
 * Deterministic heuristic, biased toward "question":
 *   1. idleMode "off"   -> always finished
 *   2. idleMode "always" -> always question
 *   3. trailing "?" on the (preprocessed) text -> question
 *   4. any configured question pattern matches -> question
 *   5. otherwise -> finished
 */

export type IdleMode = "heuristic" | "always" | "off";
export type IdleClass = "question" | "finished";

/** Defaults from SPEC.md §6.1. `patterns` in config replaces this list. */
export const DEFAULT_QUESTION_PATTERNS: readonly string[] = [
  "\\bshould i\\b",
  "\\bshould we\\b",
  "\\bshall i\\b",
  "\\bwould you like\\b",
  "\\bdo you want\\b",
  "\\bwant me to\\b",
  "\\bdo you prefer\\b",
  "\\bdo you mind\\b",
  "\\bdoes that work\\b",
  "\\blet me know\\b",
  "\\bwhich one\\b",
  "\\bwhich option\\b",
  "\\bhow about\\b",
  "\\bany thoughts\\b",
  "\\bany questions\\b",
  "\\bsound good\\b",
  "\\blook good to you\\b",
];

/** Strip noise so classification works on prose. */
export function preprocess(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`[^`\n]*`/g, " ") // inline code
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // markdown links → label
    .replace(/https?:\/\/\S+/g, " ") // bare URLs
    .replace(/^[>#\-\s]*[-*+] /gm, "") // list/quote markers
    .replace(/[*_~#>]+/g, " ") // emphasis / heading markers
    .replace(/\s+/g, " ")
    .trim();
}

export function classify(
  rawText: string,
  mode: IdleMode = "heuristic",
  patterns?: readonly string[],
): IdleClass {
  if (mode === "off") return "finished";
  if (mode === "always") return "question";

  const text = preprocess(rawText);
  if (!text) return "finished";

  // Rule 3: trailing question mark on the end of the message.
  if (text.endsWith("?")) return "question";

  // Rule 4: any phrase pattern anywhere in the final message.
  const list = patterns && patterns.length > 0 ? patterns : DEFAULT_QUESTION_PATTERNS;
  for (const source of list) {
    try {
      if (new RegExp(source, "i").test(text)) return "question";
    } catch {
      // Invalid user-supplied pattern: ignore it rather than crashing the loop.
    }
  }
  return "finished";
}

/** Short single-line excerpt for notification bodies. */
export function excerpt(text: string, max = 240): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1) + "…";
}
