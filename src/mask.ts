// Masks what looks like a credential in a command or its output before the
// band, the pane or the handover file shows it. Best effort: the handover is
// a file in the project, and a pasted token there is worse than a lost hint.

const RULES: readonly [RegExp, string][] = [
  // NAME_TOKEN=..., API_KEY=..., PASSWORD=... (env assignments and flags)
  [/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|AUTH|CREDENTIALS?)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi, '$1=***'],
  // --token xyz, --password=xyz, --api-key xyz
  [/(--?(?:token|password|passwd|secret|api[-_]?key|auth|key))(=|\s+)("[^"]*"|'[^']*'|\S+)/gi, '$1$2***'],
  // curl -u user:password, --user user:password (only a value with a colon: `git push -u origin` stays)
  [/((?:^|\s)(?:-u|--user)(?:=|\s+))("[^"]*:[^"]*"|'[^']*:[^']*'|[^\s:'"]+:\S+)/g, '$1***'],
  // X-Api-Key: ..., X-Auth-Token: ... (header names that say what they carry)
  [/\b(x-[a-z0-9-]*(?:key|token|secret|auth|signature)[a-z0-9-]*)(\s*:\s*)[^"'\s]+/gi, '$1$2***'],
  // -H "Authorization: ...", --header 'Cookie: ...'
  [/((?:-H|--header)(?:\s+|=)["']?(?:proxy-)?(?:authorization|cookie)\s*:\s*)[^"'\n]+/gi, '$1***'],
  // Authorization: / Cookie: header lines, as `curl -v` prints them
  [/^([<>]?\s*(?:proxy-)?(?:authorization|cookie|set-cookie)\s*:\s*)\S.*$/gim, '$1***'],
  // Bearer xyz / Basic xyz / Token xyz
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ***'],
  // mysql -pSECRET: the password glued to -p
  [/\b((?:mysql|mysqldump|mysqladmin|mysqlimport|mariadb|mariadb-dump)\b[^\n|;&]*?\s-p)(?=[^\s-])\S+/g, '$1***'],
  // "password": "...", 'api_key': '...' (JSON, YAML and config dumps, quoted values)
  [/(["']?\b[A-Za-z0-9_-]*(?:password|passwd|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key)[A-Za-z0-9_-]*["']?\s*:\s*)("[^"]*"|'[^']*')/gi, '$1"***"'],
  // password: hunter2 (YAML and .env-like lines, unquoted values)
  [/^(\s*[A-Za-z0-9_-]*(?:password|passwd|secret)[A-Za-z0-9_-]*\s*:\s*)(?!["'])\S.*$/gim, '$1***'],
  // user:password@ in URLs
  [/(\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1***@'],
  // Well-known token shapes: Anthropic and OpenAI, GitHub, Slack, AWS, Google, Stripe, npm, GitLab, JWTs
  [
    /\b(sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|[sr]k_(?:live|test)_[A-Za-z0-9]{10,}|npm_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g,
    '***',
  ],
]

export function maskSecrets(text: string): string {
  let out = text
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  return out
}
