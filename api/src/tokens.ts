import { SignJWT, jwtVerify } from "jose";
import { config } from "./config.ts";

const sessionKey = new TextEncoder().encode(config.sessionSecret);
const ticketKey = new TextEncoder().encode(config.ticketSecret);

export interface SessionClaims {
  sub: string; // our User.id
  accountsId: string;
  username: string;
  isAdmin: boolean;
}

export async function signSession(claims: SessionClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${config.sessionTtlSeconds}s`)
    .setIssuer("serika-social")
    .sign(sessionKey);
}

export async function verifySession(token: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, sessionKey, { issuer: "serika-social" });
  return payload as unknown as SessionClaims;
}

export interface TicketClaims {
  sub: string; // User.id
  instanceId: string;
  username: string;
  avatarId: string | null;
  jti: string; // single-use guard, checked against Redis by the relay path
}

/// A join ticket authorizes exactly one connection to exactly one instance. It's separate
/// from the session token so the relay never sees a long-lived credential — the worst a
/// leaked ticket can do is join one instance for 60 seconds.
export async function signTicket(claims: Omit<TicketClaims, "jti">): Promise<{ token: string; jti: string }> {
  const jti = crypto.randomUUID();
  const token = await new SignJWT({ ...claims, jti })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${config.ticketTtlSeconds}s`)
    .setIssuer("serika-social")
    .setAudience("instanced")
    .sign(ticketKey);
  return { token, jti };
}

export async function verifyTicket(token: string): Promise<TicketClaims> {
  const { payload } = await jwtVerify(token, ticketKey, {
    issuer: "serika-social",
    audience: "instanced",
  });
  return payload as unknown as TicketClaims;
}
