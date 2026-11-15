# Intake: how any workflow tool stores into the substrate

One endpoint, no tool-specific code in Heimdall. n8n, Node-RED, Activepieces, a shell script and a cron job all use it the same way.

```
POST http://127.0.0.1:<port>/api/intake
X-Heimdall-Token: <HEIMDALL_INTAKE_TOKEN>
Content-Type: application/json

{
  "source": { "system": "n8n", "workflow": "wf_123", "workflowName": "Stripe customers",
              "workflowVersion": "7", "execution": "9041" },
  "items": [ { "key": "cus_Nf4k", "value": { "name": "Ada" } } ]
}
```

- `source.system` is a plain token (`n8n`, `node-red`, `activepieces`, `curl`). `source.workflow` is required. The rest is provenance.
- `items` is 1 to 500 entries. `key` should be stable (the record's own id): the same key always lands at the same address, so a later run is a new entry at that address (a revision, with its own execution id), never an overwrite. Heimdall does not drop repeats; if the value is unchanged, send nothing. The key is hashed before it goes into the address, since it may be personal.
- Each item is woven as a `pulled` entry (INS·Figure) by Heimdall's own writer, with the sha256 of the item and of the request body. Heimdall writes only what it pulled; judgements stay with Penelope.
- Refused with 422 if any key in `value` or `source` looks like a credential (authorization, cookie, password, secret, api_key, access_token, refresh_token and similar). Strip it in the workflow. Secrets stay in the tool.
- 401 for a bad token, 403 when `HEIMDALL_INTAKE_TOKEN` is not set (intake is off by default), 409 when writing is off (start with `--write`), 502 when the log refused some items (the response lists which).
- The server listens on 127.0.0.1 only. A tool in Docker needs to reach the host's loopback some other way; do not widen the bind without thinking about the token.

Run it:

```
HEIMDALL_INTAKE_TOKEN=<long random string> \
  node ledgers/heimdall/ui/serve.mjs --pharos pharos/lib/pharos.mjs --dir <log dir> --write
```

Tool versions checked 2026-11-15 (use the latest of each): n8n 2.47.7 (HTTP Request node 4.4), Node-RED 5.0.9, Activepieces 0.93.0.
