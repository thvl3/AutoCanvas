import type {
  BridgeOperation,
  BrowserResult,
} from "../../src/bridge/protocol.js";

export type ExecutionOutcome =
  | { ok: true; result: BrowserResult }
  | {
      ok: false;
      error: { code: string; message: string; retryable: boolean };
    };

/** Serialized by chrome.scripting. Keep every runtime dependency inside this function. */
export async function executeInCanvas(
  origin: string,
  operation: BridgeOperation,
): Promise<ExecutionOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  const messages: Record<string, string> = {
    canvas_timeout:
      "Canvas request timed out. Retry after the tab finishes loading.",
    canvas_permission_denied:
      "Canvas has locked this resource or denied permission.",
    canvas_download_redirect_denied:
      "This file redirects to a storage host. Redirected downloads are not supported; use Canvas directly.",
    canvas_download_origin_denied:
      "File downloads are restricted to the configured Canvas origin; CDN redirects are not supported.",
    canvas_origin_changed: "Open the configured Canvas origin and retry.",
    canvas_authentication_required:
      "Sign in to Canvas in the open tab, then retry.",
    canvas_invalid_response: "Canvas did not return the expected content.",
    canvas_response_too_large:
      "Canvas response exceeds the configured byte limit.",
  };
  function fail(code: string): never {
    throw new Error(code);
  }
  async function request(
    path: string,
    init: RequestInit = {},
    file = false,
  ): Promise<Response> {
    if (location.origin !== origin || new URL(origin).protocol !== "https:")
      fail("canvas_origin_changed");
    const target = new URL(path, origin);
    if (
      target.origin !== origin ||
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.hash
    )
      fail("canvas_origin_changed");
    const response = await fetch(target.href, {
      ...init,
      method: init.body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Accept: "application/json+canvas-string-ids",
        ...init.headers,
      },
    });
    if (
      file &&
      (response.type === "opaqueredirect" ||
        (response.status >= 300 && response.status < 400))
    )
      fail("canvas_download_redirect_denied");
    if (response.status === 403) fail("canvas_permission_denied");
    if (
      response.status === 401 ||
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)
    )
      fail("canvas_authentication_required");
    return response;
  }
  async function bytes(
    response: Response,
    limit = 8 * 1024 * 1024,
  ): Promise<Uint8Array> {
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          fail("canvas_response_too_large");
        }
        chunks.push(value);
      }
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
  async function json(response: Response): Promise<BrowserResult> {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) fail("canvas_authentication_required");
    const link = response.headers.get("link");
    return {
      status: response.status,
      body: JSON.parse(new TextDecoder().decode(await bytes(response))),
      contentType,
      ...(link ? { link } : {}),
    };
  }
  try {
    if (operation.type === "download-file") {
      const metadata = (
        await json(
          await request(
            `/api/v1/courses/${operation.courseId}/files/${operation.fileId}`,
          ),
        )
      ).body as { url: string; size?: number; locked_for_user?: boolean };
      if (metadata.locked_for_user) fail("canvas_permission_denied");
      if (metadata.size !== undefined && metadata.size > operation.maxBytes)
        fail("canvas_response_too_large");
      const target = new URL(metadata.url);
      if (
        target.origin !== origin ||
        target.protocol !== "https:" ||
        target.username ||
        target.password ||
        target.hash
      )
        fail("canvas_download_origin_denied");
      const response = await request(metadata.url, {}, true);
      const data = await bytes(response, operation.maxBytes);
      let binary = "";
      for (let i = 0; i < data.length; i += 0x8000)
        binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
      return {
        ok: true,
        result: {
          status: response.status,
          body: { id: operation.fileId, size: data.length },
          contentType: response.headers.get("content-type") ?? "",
          bytesBase64: btoa(binary),
        },
      };
    }
    if (operation.type === "canvas-page") {
      const path = `/courses/${operation.courseId}/${operation.kind === "page" ? `pages/page_id:${operation.id}` : `assignments/${operation.id}`}`;
      const response = await request(path);
      const html = new TextDecoder().decode(await bytes(response));
      const parsed = new DOMParser().parseFromString(html, "text/html");
      const content = parsed.querySelector(
        operation.kind === "page"
          ? "#wiki_page_show .show-content"
          : "#assignment_show #assignment_description, #assignment_show .description.user_content",
      );
      const title = parsed
        .querySelector(
          operation.kind === "page"
            ? "#wiki_page_show h1"
            : "#assignment_show h1",
        )
        ?.textContent?.trim();
      if (!content || !title) fail("canvas_invalid_response");
      for (const element of content.querySelectorAll(
        "script,style,iframe,object,embed,input,form,meta,link,base,template,noscript,[hidden]",
      ))
        element.remove();
      const attributes = new Set([
        "href",
        "src",
        "alt",
        "title",
        "colspan",
        "rowspan",
        "width",
        "height",
        "class",
      ]);
      for (const element of content.querySelectorAll("*")) {
        for (const attribute of [...element.attributes]) {
          if (!attributes.has(attribute.name)) {
            element.removeAttribute(attribute.name);
            continue;
          }
          if (attribute.name === "href" || attribute.name === "src") {
            try {
              if (
                !["https:", "http:"].includes(
                  new URL(attribute.value, origin).protocol,
                )
              )
                element.removeAttribute(attribute.name);
            } catch {
              element.removeAttribute(attribute.name);
            }
          }
        }
      }
      const body =
        operation.kind === "page"
          ? {
              page_id: operation.id,
              id: operation.id,
              title,
              body: content.innerHTML,
              source: "canvas-page",
            }
          : {
              id: operation.id,
              name: title,
              description: content.innerHTML,
              source: "canvas-page",
            };
      return {
        ok: true,
        result: { status: response.status, body, contentType: "text/html" },
      };
    }
    let path = "/api/v1/users/self/profile";
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (operation.type === "canvas-get") path = operation.path;
    if (operation.type === "graphql-query") {
      path = "/api/graphql";
      headers["Content-Type"] = "application/json";
      headers["X-Requested-With"] = "XMLHttpRequest";
      // Mirrors Canvas's Apollo client. Only this anti-CSRF cookie is extracted; it never leaves MAIN.
      const csrf = document.cookie.match(/(?:^|;\s*)_csrf_token=([^;]*)/)?.[1];
      if (csrf) headers["X-CSRF-Token"] = decodeURIComponent(csrf);
      body = JSON.stringify({
        query: operation.query,
        variables: operation.variables,
      });
    }
    return {
      ok: true,
      result: await json(
        await request(path, {
          headers,
          ...(body === undefined ? {} : { body }),
        }),
      ),
    };
  } catch (error) {
    const code = controller.signal.aborted
      ? "canvas_timeout"
      : error instanceof Error && messages[error.message]
        ? error.message
        : "canvas_invalid_response";
    return {
      ok: false,
      error: {
        code,
        message: messages[code]!,
        retryable: code === "canvas_timeout",
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
