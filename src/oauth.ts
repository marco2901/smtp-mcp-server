import type { Express, Request, Response } from "express";

export interface OAuthDiscoveryConfig {
  /** Public HTTPS base URL of this MCP server, e.g. https://mail-mcp.example.com */
  publicBaseUrl: string;
  /** OIDC issuer (Authelia) base URL, e.g. https://authelia.example.com */
  issuerUrl: string;
  /** Scopes advertised to the client */
  scopes: string[];
  resourceName: string;
  resourceDocumentation?: string;
}

/**
 * Value for the `WWW-Authenticate` header returned on 401, pointing MCP
 * clients (Claude.ai) at the protected-resource metadata so they can discover
 * the authorization server per RFC 9728 / the MCP auth spec.
 */
export function wwwAuthenticate(cfg: OAuthDiscoveryConfig): string {
  return `Bearer realm="mail-mcp", resource_metadata="${cfg.publicBaseUrl}/.well-known/oauth-protected-resource"`;
}

/**
 * Register the public (unauthenticated) OAuth discovery endpoints that Claude.ai
 * fetches before authenticating. These must be mounted BEFORE the auth middleware.
 *
 * Authelia itself is the authorization server — we simply advertise its endpoints
 * so the client runs the authorization-code flow directly against Authelia. No
 * OAuth proxying happens here.
 */
export function registerOAuthDiscovery(app: Express, cfg: OAuthDiscoveryConfig): void {
  const issuer = cfg.issuerUrl.replace(/\/+$/, "");

  const protectedResource = {
    resource: cfg.publicBaseUrl,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: cfg.scopes,
    resource_name: cfg.resourceName,
    ...(cfg.resourceDocumentation ? { resource_documentation: cfg.resourceDocumentation } : {}),
  };

  const authorizationServer = {
    issuer,
    authorization_endpoint: `${issuer}/api/oidc/authorization`,
    token_endpoint: `${issuer}/api/oidc/token`,
    jwks_uri: `${issuer}/jwks.json`,
    introspection_endpoint: `${issuer}/api/oidc/introspection`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: cfg.scopes,
  };

  const send = (res: Response, body: unknown) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.json(body);
  };

  // Claude.ai probes both the bare path and the resource-suffixed variant.
  app.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) =>
    send(res, protectedResource)
  );
  app.get("/.well-known/oauth-protected-resource/mcp", (_req: Request, res: Response) =>
    send(res, protectedResource)
  );
  app.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) =>
    send(res, authorizationServer)
  );
  app.get("/.well-known/oauth-authorization-server/mcp", (_req: Request, res: Response) =>
    send(res, authorizationServer)
  );
}
