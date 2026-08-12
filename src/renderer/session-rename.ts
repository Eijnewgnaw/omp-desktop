export const SESSION_TITLE_MAX_LENGTH = 240;

export type SessionTitleValidation =
  | { valid: true; title: string }
  | { valid: false; error: string };

export function validateSessionTitle(value: string): SessionTitleValidation {
  const title = value.trim();
  if (!title) return { valid: false, error: "会话名称不能为空" };
  if (title.length > SESSION_TITLE_MAX_LENGTH) {
    return { valid: false, error: `会话名称不能超过 ${SESSION_TITLE_MAX_LENGTH} 个字符` };
  }
  return { valid: true, title };
}
