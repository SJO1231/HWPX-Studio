export class HwpxError extends Error {
  code: string;
  where?: string;

  constructor(code: string, message: string, where?: string) {
    super(message);
    this.name = "HwpxError";
    this.code = code;
    if (where !== undefined) this.where = where;
  }
}

export type Issue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  where?: string;
};

export function makeIssue(
  severity: Issue["severity"],
  code: string,
  message: string,
  where?: string,
): Issue {
  return where === undefined ? { severity, code, message } : { severity, code, message, where };
}
