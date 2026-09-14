import { z } from "zod";

export const DEFAULT_ORIGIN = "https://byui.instructure.com";
export const DEFAULT_PORT = 47821;
const originSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.origin === value &&
      !url.username &&
      !url.password &&
      !value.includes("*")
    );
  } catch {
    return false;
  }
});
const portSchema = z.number().int().min(1).max(65535);
const inputSchema = z
  .object({
    origin: originSchema,
    port: portSchema,
    code: z.string().min(1).max(128),
    extensionOrigin: z
      .string()
      .regex(
        /^(?:chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
      ),
  })
  .strict();
export const pairingSchema = z
  .object({
    origin: originSchema,
    port: portSchema,
    extensionSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

export interface Pairing {
  origin: string;
  port: number;
  extensionSecret: string;
}
export interface PairInput {
  origin: string;
  port: number;
  code: string;
  extensionOrigin: string;
}
export type PairApi = Pick<typeof chrome, "permissions" | "storage">;

export async function pairCanvas(
  api: PairApi,
  fetcher: typeof fetch,
  input: PairInput,
): Promise<{ origin: string; port: number }> {
  if (!inputSchema.safeParse(input).success)
    throw new Error(
      "Invalid pairing settings. Use an exact HTTPS Canvas origin, port 1–65535, and the current pairing code.",
    );
  if (!(await api.permissions.request({ origins: [`${input.origin}/*`] })))
    throw new Error(
      "Permission denied. Allow access only to your configured Canvas site to pair.",
    );
  const response = await fetcher(`http://127.0.0.1:${input.port}/pair`, {
    method: "POST",
    credentials: "omit",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      protocolVersion: 1,
      code: input.code,
      extensionOrigin: input.extensionOrigin,
    }),
  });
  if (!response.ok)
    throw new Error(
      "Pairing was rejected. Check the bridge origin and port, generate a fresh code, or wait a minute if rate limited.",
    );
  const parsed = z
    .object({
      protocolVersion: z.literal(1),
      origin: originSchema,
      extensionSecret: pairingSchema.shape.extensionSecret,
    })
    .strict()
    .safeParse(
      await response.json().catch(() => {
        throw new Error(
          "Pairing response is invalid. Restart the local bridge and generate a new code.",
        );
      }),
    );
  if (!parsed.success || parsed.data.origin !== input.origin)
    throw new Error(
      "Pairing response does not match the selected Canvas origin or protocol. Check the bridge configuration.",
    );
  const pairing = parsed.data;
  await api.storage.local.set({
    pairing: {
      origin: input.origin,
      port: input.port,
      extensionSecret: pairing.extensionSecret,
    },
  });
  return { origin: input.origin, port: input.port };
}
