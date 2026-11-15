# Workflow tools that store into the substrate

All of them end at the same call: `POST /api/intake` (contract: `../ui/INTAKE.md`). Pick whichever tool you like; Heimdall does not know which one it is. Always install the latest release of the tool.

| Tool | Licence (verify) | Start it | Import |
|---|---|---|---|
| **n8n** | Sustainable Use (fair-code) | `npx n8n@latest` | Workflows → Import from file → `n8n-to-heimdall.workflow.json`. Create a credential **Header Auth** named `Heimdall intake` with name `X-Heimdall-Token` and your token. |
| **Node-RED** | Apache 2.0 | `npx node-red@latest` (set `HEIMDALL_INTAKE_TOKEN` in its environment) | Menu → Import → `node-red-to-heimdall.flow.json` |
| **Activepieces** | MIT (core) | follow its current install docs (Docker) | Add an **HTTP** step ("Send HTTP request"), POST to the intake URL, header `X-Heimdall-Token` from a connection, body as in INTAKE.md. No template here: its flow export format changes between releases. |
| **Anything else** | n/a | n/a | `curl -X POST -H 'X-Heimdall-Token: …' -H 'content-type: application/json' -d '{"source":{"system":"curl","workflow":"adhoc"},"items":[{"key":"1","value":{"hello":"world"}}]}' http://127.0.0.1:7421/api/intake` |

The n8n and Node-RED templates have been checked against the node versions in the latest packages (n8n HTTP Request 4.4, Code 2), but **not imported into a running n8n or Node-RED**. The n8n template turns off saving of successful executions so n8n keeps no second copy of your data.
