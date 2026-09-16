/* The lock screen. NO SCRIPT AND NO EXTERNAL ASSET, on purpose: helmet's CSP
   allows no inline script, and every static file behind the gate is blocked,
   so a page that reached for one would render broken to the one visitor who
   most needs it to work. A plain form POST needs neither. */
/* BOTH SLOTS ARE ESCAPED EVEN THOUGH BOTH CALLERS PASS LITERALS. This is the
   one template in the server that builds HTML by interpolation, and the
   obvious future edit — passing an exception's message through as the error
   line — would turn it into a real hole. Escaping here costs nothing and
   means that edit stays safe. */
const esc = s => String(s).replace(/[&<>"']/g,
  c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);

export function gatePage({ error = "", title = "Pose Party" } = {}){
  const note = error
    ? `<p class="err">${esc(error)}</p>`
    : `<p class="sub">This build is in private testing. Enter the code you were given.</p>`;
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>
  :root{ color-scheme: dark }
  *{ box-sizing:border-box }
  body{ margin:0; min-height:100vh; display:grid; place-items:center;
        background:#123a63; color:#fff7e6; padding:6vh 5vw;
        font:16px/1.5 ui-rounded, "Trebuchet MS", system-ui, sans-serif; }
  .card{ width:min(30rem,100%); background:#fff7e6; color:#123a63;
         border-radius:14px; padding:2.2rem 2rem; text-align:center;
         box-shadow:0 18px 0 -6px rgba(0,0,0,.25); }
  h1{ margin:0 0 .5rem; font-size:1.9rem; letter-spacing:.02em }
  .sub,.err{ margin:0 0 1.4rem; font-size:.98rem }
  .sub{ color:#41618a }
  .err{ color:#c02d1c; font-weight:700 }
  label{ display:block; text-align:left; font-weight:700; font-size:.82rem;
         letter-spacing:.09em; text-transform:uppercase; color:#41618a; margin-bottom:.4rem }
  input{ width:100%; padding:.85rem 1rem; font-size:1.15rem; letter-spacing:.16em;
         text-align:center; border:2px solid #123a63; border-radius:9px;
         background:#fff; color:#123a63; font-family:inherit }
  input:focus{ outline:3px solid #e8a020; outline-offset:2px }
  button{ width:100%; margin-top:1rem; padding:.9rem 1rem; font-size:1.05rem;
          font-weight:800; letter-spacing:.06em; border:0; border-radius:9px;
          background:#e8a020; color:#123a63; cursor:pointer; font-family:inherit }
  button:hover{ filter:brightness(1.07) }
  button:active{ transform:translateY(2px) }
  .foot{ margin:1.3rem 0 0; font-size:.8rem; color:#41618a }
  .legal{ margin:.7rem 0 0; font-size:.8rem }
  .legal a{ color:#41618a; font-weight:700 }
</style>
<div class="card">
  <h1>${esc(title)}</h1>
  ${note}
  <form method="POST" action="/__gate">
    <label for="code">Access code</label>
    <input id="code" name="code" autocomplete="off" autocapitalize="off"
           autocorrect="off" spellcheck="false" autofocus required>
    <button type="submit">Let me in</button>
  </form>
  <p class="foot">No code? Ask whoever sent you the link.</p>
  <p class="legal"><a href="/privacy">Privacy Policy</a> &middot; <a href="/terms">Terms of Use</a></p>
</div>`;
}
