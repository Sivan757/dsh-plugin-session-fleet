# CONTEXT.md

Domain vocabulary for reviewers and agents. Use these terms exactly.

| Term             | Meaning                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Fleet            | The set of ordinary top-level DSH sessions one agent can list, search, create, and message.                             |
| Peer input       | A delivery that arrives from another agent, not from the user. It carries the dedicated `session-fleet` message source. |
| Ordinary session | A top-level session. Subagent sessions are internal delegation and stay outside the fleet.                              |
| Delivery         | One message handed to a target session: `queue` waits for its current turn, `steer` injects into it.                    |
| Calling agent    | The agent whose tool call is executing. Fleet tools act on its behalf and use its workspace as the default.             |
| Support window   | The host version range this plugin declares: `>=0.2.0-rc.2 <0.3.0-0`.                                                   |
| Build baseline   | The exact host version the repository installs for building and tests.                                                  |
