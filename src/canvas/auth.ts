import { validateAccessToken } from "../config.js";

/** Replaceable for refreshed OAuth access tokens; never used for query-string auth. */
export interface AuthProvider {
  authorization(): string | Promise<string>;
}

export class BearerTokenAuth implements AuthProvider {
  readonly #token: string;
  constructor(token: string) {
    this.#token = validateAccessToken(token);
  }
  authorization(): string {
    return `Bearer ${this.#token}`;
  }
}
