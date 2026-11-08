---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Add the approval whitelist and working-hours auto-approval of TASK-PLAN T2-08.
An Approval may now name the `target` its Action reaches, and the Policy's
`approval` block can whitelist internal domains at the tenant level or per
Source, during a local working-hours window or with an explicit `always`
exemption. `requestApproval` records the request and, on a match, saves an
ordinary `approved` Approval decided by `policy/auto-approval` with its reason
instead of skipping it. A `spend` Action is never automatic, and a target outside
the whitelist or window stays for a person. The settings are not part of the
Policy version, so changing them affects later requests without revoking a
Mandate.
