// TLS front monitoring (PR #5: production origin).
//
// Observes the HTTPS front's certificate (e.g. the jaredlodwick.design
// site that proxies the read APIs) and reports how many days remain before
// it expires. Read-only: this never touches the TLS configuration — it only
// watches and reports, so a worn-out cert can be renewed before it breaks
// the HTTPS discovery URL.
//
//   const { certExpiryDays, checkTlsFront } = require("./tls-check");
//   const state = { ok: null, host, checked_at: null, expires_in_days: null,
//                   not_after: null, error: null };
//   await checkTlsFront(state, { host, port, warnDays, timeoutMs });
//
// checkTlsFront never rejects: on any failure it records ok:false + error
// and resolves, so a monitoring hiccup can never crash the lobby.
const tls = require("tls");
const net = require("net");

// Days until the certificate expires. cert is a tls.getPeerCertificate()
// result (needs a valid_to field). Returns a float, negative when expired,
// or null when the expiry can't be determined.
function certExpiryDays(cert) {
  if (!cert || typeof cert.valid_to !== "string") return null;
  const end = Date.parse(cert.valid_to);
  if (!Number.isFinite(end)) return null;
  return (end - Date.now()) / 86400000;
}

// One TLS handshake against host:port; fills `state` in place and resolves.
// opts: { host, port, warnDays, timeoutMs }.
function checkTlsFront(state, opts) {
  opts = opts || {};
  const host = opts.host;
  const port = opts.port || 443;
  const warnDays = opts.warnDays != null ? opts.warnDays : 30;
  const timeoutMs = opts.timeoutMs || 10000;
  return new Promise((resolve) => {
    if (!host) {
      state.ok = null;
      state.error = "tls check disabled (no host configured)";
      resolve();
      return;
    }
    let done = false;
    const finish = (ok, error, cert) => {
      if (done) return;
      done = true;
      state.checked_at = Date.now();
      if (ok) {
        const days = certExpiryDays(cert);
        state.not_after = (cert && cert.valid_to) || null;
        state.expires_in_days = days == null ? null : Math.floor(days);
        if (days == null) {
          state.ok = false;
          state.error = "could not read certificate expiry";
        } else if (days < 0) {
          state.ok = false;
          state.error = "certificate expired";
        } else if (days < warnDays) {
          state.ok = false;
          state.error =
            "certificate expires in " + Math.floor(days) + " days (warn threshold " + warnDays + ")";
        } else {
          state.ok = true;
          state.error = null;
        }
      } else {
        state.ok = false;
        state.error = error;
      }
      resolve();
    };
    let socket;
    try {
      socket = tls.connect(
        {
          host: host,
          port: port,
          // RFC 6066 forbids IP literals as SNI server names.
          servername: net.isIP(host) ? undefined : host,
          timeout: timeoutMs,
          rejectUnauthorized: true,
        },
        () => {
          let cert = null;
          try {
            cert = socket.getPeerCertificate();
          } catch (_) {
            cert = null;
          }
          const err = socket.authorizationError;
          socket.destroy();
          if (err) finish(false, "certificate not trusted: " + err, null);
          else finish(true, null, cert);
        }
      );
    } catch (e) {
      finish(false, "tls check failed: " + (e && e.message ? e.message : "unknown"), null);
      return;
    }
    socket.on("error", (e) =>
      finish(false, "tls check failed: " + (e && e.message ? e.message : "unknown"), null)
    );
    socket.on("timeout", () => {
      try {
        socket.destroy();
      } catch (_) {}
      finish(false, "tls check timed out", null);
    });
  });
}

module.exports = { certExpiryDays, checkTlsFront };
