import pino, { type Logger } from "pino";

/** fd 1 belongs exclusively to the MCP JSON-RPC transport. */
export function createLogger(level = "info"): Logger {
  return pino(
    {
      level,
      base: undefined,
      redact: {
        paths: [
          "accessToken",
          "access_token",
          "token",
          "authorization",
          "password",
          "headers.authorization",
          "headers.Authorization",
          "req.headers.authorization",
          "*.accessToken",
          "*.access_token",
          "*.token",
          "*.authorization",
          "*.password",
        ],
        censor: "[REDACTED]",
      },
    },
    pino.destination({ dest: 2, sync: true }),
  );
}
