# Private QQ Agent broker deployment example

These files are templates, not evidence of a deployed or logged-in bot. The
service runs a new SnowLuma container and a separate QQ Agent container for each
request. It never starts Bridge or DSH. Existing bots and their services are not
stopped or modified by this installer-free example.

Use Node 24, Docker, slirp4netns, nsenter and ip on Linux. The pinned SnowLuma
image must include xwininfo, xwd, Python 3, libX11 and libXtst and use the verified
320 by 460 QQ login window. The start script is a separately reviewed deployment
input, mounted read-only; this repository does not invent a container launch
script for an unknown image. Pin both image digests and use an audited immutable
QQ Agent release containing its installed dependencies. The entire release is
mounted read-only. Keep all primary account databases, keys and runtime data
outside that release.

Place the private config, model template, speech credential and service secret
under a root-owned directory with mode 0700; use mode 0600, regular non-symlink
files. Generate the internal secret with 32 random bytes encoded as base64url.
Never reuse the primary console or OneBot token. Configure the platform's
createHostedLoginClient with the broker's 127.0.0.1 URL and this private secret.
Do not expose the broker port or per-instance ports through the public proxy.
The supplied systemd unit runs only after an operator installs it; it is not
automatically enabled by this code. KillMode=process lets the existing isolated
network helpers survive a broker restart and be adopted through their private
API sockets. Container labels and immutable request ownership are checked before
any container is started or removed.

The model example intentionally contains an invalid endpoint, an empty API key
and null prices. Replace them with approved credentials and verified pricing in
the private file. The broker allows only api/providers/dshProviderKeys,
productionBudget, speech and hostedFundingLimits. dshProviderKeys is an existing
QQ Agent provider-map field; it does not launch a DSH process. A new instance
receives no primary account DB, credentials database, persona, group list, chat
history or existing ledger. Only explicitly approved model and speech secrets
are injected. Speech uses a per-request 0600 file owned by that instance's UID,
mounted read-only into its container. Unrelated primary secrets are never read.

The example limits the whole instance to 3 CNY/day and each chat to 1.5 CNY/day;
speech is additionally limited to 0.3 CNY/day. These are protected service limits,
not ordinary user preferences. productionBudget.totalDailyLimitCny must be
positive and cannot exceed maxBotDailyLimitCny. The new worker starts with empty
whitelists and funding; the platform must explicitly synchronize the owner's
chosen chats and settings through its authenticated internal worker API. Merely
scanning a QQ account does not authorize a paid call. The app integration must
implement the instance total budget, strict expected-QQ checks on receive/send,
and GET /api/hosted/identity before a worker can report ready.

The default admission threshold requires at least 1,120,000 KiB of available
memory before creating or restarting QQ (640 MiB QQ, 192 MiB Agent plus reserve).
Agent creation independently requires 458,752 KiB. A smaller host returns
RESOURCE and preserves current services; no extra real QQ login is attempted to
prove capacity. A slot count is not a capacity benchmark. Measure the selected
image and workload before increasing maxBots or lowering memory limits.

The platform stores request ID, owner, expected QQ, reserved slot, state and
version in its own hosted SQL file. Every browser operation rechecks the current
session and resolves only requestId; clients cannot submit connection addresses
or tokens. The broker persists the same immutable association and private tokens
in hosted-runtime.sqlite. All HTTP actions are POST /v1/start, /v1/status,
/v1/refresh, /v1/reconnect and /v1/cancel, authenticated by the internal secret.
Request fields come from the platform row: requestId, ownerUserId, expectedQQ,
slot and version. Responses may contain a server-only connection; only
publicHostedLoginState and the public platform request may reach the browser.

SQL reservations survive restart. Uncertain cleanup retains the slot until a
positive stop confirmation; retry cancel repairs it. Recovery restarts reserved
instances while honoring actual memory checks, completes pending cleanup, and
keeps QQ identity mismatches paused. Login windows expire after two minutes;
unused login attempts are stopped after ten minutes. No data directory is
deleted on cancellation. Back up both SQL databases and per-request data before
any operational upgrade, and retain the exact image/release inputs for recovery.
