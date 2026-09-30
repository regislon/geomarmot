# Parity with the reference application

GeoMarmot began as a port of an existing browser ETL. Its behaviour was captured before the port as
fixture expectations (`transformers/*/tests.json`) and I/O and end-to-end tests, and every change
since has had to keep them passing. This page records the checklist and the places where GeoMarmot
deliberately differs.

## Deliberate differences

| Where | Reference behaviour | GeoMarmot | Why |
|---|---|---|---|
| FeatureJoiner, Joined port | right-side attributes were never added (a hook argument was misnamed, so the right schema was always empty) | right attributes are added, clashing names suffixed | the documented behaviour; the reference was a bug |
| Reprojection transformer | a vendor-specific name | `Reprojector` | independent naming |
| Rejected rows | a vendor-specific attribute name | `rejection_code` | independent naming |
| SQL in parameters | unrestricted | restricted to the node's input unless unrestricted is chosen explicitly | security (docs/security.md) |
| Saved graphs | an unversioned format | `geomarmot-graph` v1 | docs/decisions/0007 |

## Checklist

Filled in as the parity tests land; see PLAN.md §1 for the full list.
