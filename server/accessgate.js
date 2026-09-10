/* THE PRIVATE-BETA LOCK.
   One shared code stands between the internet and an unreleased game. It is
   deliberately the smallest thing that can work, because new auth code is new
   attack surface and avoiding that is the whole reason it exists.

   IT IS OFF UNLESS `ACCESS_CODE` IS SET, so local dev, `npm test` and every
   E2E suite are untouched.

   WHY A COOKIE AND NOT HTTP BASIC AUTH. The client opens Socket.IO with
   `transports:["polling","websocket"]` and then UPGRADES. Browsers do not
   reliably attach cached basic-auth credentials to a WebSocket handshake, so
   basic auth would let the page load and then drop every online match at the
   upgrade — the exact "1v1 and Party are dead" failure that is hardest to
   diagnose from the sofa. Cookies ARE sent on a same-origin WebSocket
   handshake, so one check covers the page, the poll and the upgrade.

   The cookie is an expiry stamp and its HMAC, the same shape as the TURN REST
   credential: nothing in the browser is worth stealing after it expires, and
   nobody can mint one without the secret. */
import crypto from "node:crypto";

export const COOKIE = "pp_access";

const b64url = buf => buf.toString("base64url");

function sign(secret, exp){
  return b64url(crypto.createHmac("sha256", secret).update(String(exp)).digest());
}

/* Compare in constant time. A plain `===` on a secret leaks its length and,
   over enough tries, its content. */
function sameSecret(a, b){
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if(x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

export function makeTicket(secret, ttlSec){
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return `${exp}.${sign(secret, exp)}`;
}

export function ticketValid(secret, value){
  if(typeof value !== "string") return false;
  const dot = value.indexOf(".");
  if(dot < 1) return false;
  const exp = Number(value.slice(0, dot));
  if(!Number.isFinite(exp) || exp * 1000 <= Date.now()) return false;
  return sameSecret(value.slice(dot + 1), sign(secret, exp));
}

/* Read one cookie without adding a parser dependency. Values here are our own
   base64url and digits, so there is nothing to decode. */
export function readCookie(header, name){
  if(typeof header !== "string") return null;
  for(const part of header.split(";")){
    const eq = part.indexOf("=");
    if(eq < 0) continue;
    if(part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export const codeMatches = sameSecret;
