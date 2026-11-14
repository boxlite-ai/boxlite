# Organization context review

The Console uses organization terminology throughout this flow. These screenshots
contain synthetic users, memberships, and resources from the existing MSW fixtures.

| State | Screenshot |
| --- | --- |
| Before: organization choices inside the profile menu | [Before](before.png) |
| After: explicit multi-organization login | [Login](login.png) |
| After: global switcher, light theme | [Light](switcher-light.png) |
| After: global switcher, dark theme | [Dark](switcher-dark.png) |
| After: 390px viewport | [Mobile](mobile.png) |

The before capture uses Console application code at
`30c8e674dcedca1e8516c4a2b8239f15becfed85` with the same synthetic multi-organization
mock fixtures used for the after captures. It does not include the new gate or header.

## Interaction verification

- Selecting a different organization replaced the document: a temporary window
  marker disappeared, the header changed, and the session recorded the target ID.
- Cancelling from a Box terminal retained the organization and complete current URL.
- Confirming from that terminal navigated to `/dashboard/boxes`, dropping the old
  Box ID, query, and fragment.
- A denied target membership displayed an error and retained the current organization.
- Explicit logout followed by sign-in returned to the chooser with no session selection.
- Mobile layout at 390px reported no document horizontal overflow; names and full
  IDs remained visible in the switcher.

## Automated verification

The dashboard suite covers selection counts, user-bound restoration, removed
memberships, storage refusal, network failures, duplicate clicks, search, keyboard
focus, scoped entry routes, invitation integration, and route mapping.

Two existing defects were reproduced with every production change reverted:
failed membership validation replaced the current member list, and email verification
redirected despite failed organization selection. Both assertions pass with the fix.
New login/switch entry contracts have no equivalent entry point in the base version;
their positive, negative, and boundary tests validate the new behavior.

Mock verification does not prove backend resource isolation, live OIDC recovery,
or successful live terminal disconnection. Validate those with real organizations
and distinct resources before production rollout. Non-list confirmation is deliberately
conservative, not a form-wide dirty-state registry.
