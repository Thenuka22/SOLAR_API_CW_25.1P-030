# Domain Model

This is the domain model for the Real-Time Solar Generation Data API. It does not depend on any database or framework, and the API resources are based on it.

## Entities

| Entity | Purpose | Key attributes |
| --- | --- | --- |
| Province | Top-level jurisdiction | id, name |
| District | Mid-level jurisdiction | id, province_id, name |
| GridSubstation | Grid node that installations connect to | id, district_id, name |
| SolarInstallation | A rooftop solar site | id, substation_id, meter_id, address, capacity_kw |
| GenerationReading | One timestamped generation record | id, installation_id, timestamp, power_kw, energy_kwh, voltage |
| User | SLSEA staff member who reads data | id, name, email, role, province_id, district_id |

## Relationships

All relationships are one-to-many:

- One Province has many Districts.
- One District has many GridSubstations.
- One GridSubstation has many SolarInstallations.
- One SolarInstallation has many GenerationReadings.

A User's role sets their read scope. A national user covers everything. A provincial user is linked to one Province, and a district user is linked to one District.

## Modelling rules

### The meter is identified on the installation

`meter_id` is a unique attribute of SolarInstallation. There is no separate Device entity. Each installation has one meter or inverter, and the device's only job is to identify the installation it reports for.

### Readings are immutable history

GenerationReading is an append-only time series. A reading is created once and never updated or deleted. The installation does not store last-value fields such as `last_power`. The latest reading is always read from the reading history.

### Composite resource vs composite uniqueness

- **Installation composite resource:** a read representation that returns an installation together with its related data, such as its substation, district, province and latest reading. It is an API view, not a stored entity.
- **Composite uniqueness constraint:** the pair (`installation_id`, `timestamp`) is unique in GenerationReading. An installation can have only one reading per timestamp, which stops duplicate readings from being stored.
