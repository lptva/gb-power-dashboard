# Overnight summary — generated 2026-07-05T21:35:33+00:00 (AI)

Exceptionally high wind output averaged 10,703 MW across the 24-hour window (z=+1.75 against a 14-day baseline mean of 5,374 MW), and combined with strong solar generation it drove wholesale prices sharply negative for 13 of 49 half-hourly periods between 07:00 and 14:00 UTC on 4 July, troughing at -14.08 £/MWh. CCGT averaged only 2,857 MW versus a 14-day baseline of 10,060 MW, consistent with gas-fired plant being largely displaced from the stack by renewable abundance. By the evening peak, prices recovered to 100–120 £/MWh as solar faded and demand rose above 24,000 MW; the Viking interconnector (INTVKL) switched from a baseline net-export position (-140 MW average) to net import (+442 MW overnight average).

## Anomalies
- **price_min**: -14.08 (z=-2.18) — consistent with wind output sustaining 11,000–12,600 MW throughout the morning alongside solar peaking at 10,565 MW, producing a combined renewable output that exceeded gross transmission-metered demand (~15,000–16,000 MW) during the 07:00–14:00 UTC window, clearing prices below zero across 13 half-hourly periods
- **residual_load_min**: -7867.0 (z=-2.65) — consistent with wind (12,510 MW) plus solar (10,565 MW) exceeding gross demand (15,208 MW) by 7,867 MW at 13:00 UTC on 4 July; net exports of -1,640 MW absorbed part of the surplus but residual turned deeply negative, coinciding with the period of most negative prices (-11.08 £/MWh); note this reflects a genuine oversupply condition rather than a methodology error
- **clean_dark_min**: -104.11 (z=-2.18) — consistent with the negative price periods driving coal dark spread to deeply negative levels; interpret with caution as both coal proxy and carbon price are forward-filled from prior monthly data for this date, making the absolute magnitude an estimate

## Data quality
- carbon_ffill=True on 2026-07-03, 2026-07-04: UKA carbon price forward-filled from 2026-05 monthly average; clean spark and dark spreads are estimates only
- coal_ffill=True on 2026-07-03, 2026-07-04: coal proxy (Newcastle futures) forward-filled; clean dark spread is an estimate only
- gas_sap=None for 2026-07-04: clean spark spread is computed on the three July-03 half-hourly periods only (22:30, 23:00, 23:30) — all 46 July-04 periods excluded; overnight clean_spark figure is not representative
- Series ends at 2026-07-04T22:30:00Z; July-05 overnight window (00:00–06:00 UTC) is absent from the dataset despite the ETL build timestamp of 2026-07-05T06:03:38Z — analysis window is therefore 2026-07-03T22:30Z to 2026-07-04T22:30Z
