import { DateTimeFormatter, ZoneId, ZonedDateTime } from "@js-joda/core";
import { InfluxDB } from "influx";
import { Context, Path, SourceRef, Timestamp } from "@signalk/server-api";
import {
  AggregateMethod,
  ContextsRequest,
  ContextsResponse,
  DataRow,
  HistoryApi,
  PathsRequest,
  PathsResponse,
  ValueList,
  ValuesRequest,
  ValuesResponse,
} from "@signalk/server-api/history";

export type DataResult = Omit<ValuesResponse, "context" | "range">;

const DEFAULT_EMA_PERIOD = 5;

interface PathSpec {
  path: Path;
  aggregateMethod: AggregateMethod;
  aggregateFunction: string;
  parameters: string[];
  sourceRef?: SourceRef;
  // The InfluxDB field the path's values are stored in. The v1 writer stores
  // numbers in `value`, strings in `stringValue`, booleans in `boolValue` and
  // objects in `jsonValue`. Discovered per path via `SHOW FIELD KEYS`.
  field?: string;
}

// Maps the History API aggregation methods to InfluxQL selector functions for
// numeric (`value`) fields. `sma` and `ema` are computed in post-processing on
// top of `mean` buckets, matching the signalk-to-influxdb2 implementation.
const functionForAggregate: { [key: string]: string } = {
  average: "mean",
  min: "min",
  max: "max",
  first: "first",
  last: "last",
  sma: "mean",
  ema: "mean",
};

// The InfluxDB fields the v1 writer uses. `value` holds numbers; the others hold
// strings, booleans and JSON-encoded objects respectively.
const NUMERIC_FIELD = "value";
const NON_NUMERIC_FIELDS = ["stringValue", "boolValue", "jsonValue"] as const;

// InfluxQL aggregations that are meaningful for non-numeric fields. Only
// first/last make sense for strings, booleans and JSON objects; average/min/max
// and the moving-average methods require numbers. Any other method is coerced
// to `first` for those fields, matching how navigation.position is handled.
const NON_NUMERIC_AGGREGATES = new Set(["first", "last"]);

function isNumericField(field: string | undefined): boolean {
  return field === undefined || field === NUMERIC_FIELD;
}

// Returns the InfluxQL selector function to use for a path spec, taking its
// field into account. Numeric fields keep the requested aggregation; for
// non-numeric fields only `first`/`last` are valid and anything else is
// coerced to `first`.
function aggregateFunctionFor(spec: PathSpec): string {
  if (isNumericField(spec.field)) {
    return functionForAggregate[spec.aggregateMethod] || "mean";
  }
  return NON_NUMERIC_AGGREGATES.has(functionForAggregate[spec.aggregateMethod] || "")
    ? functionForAggregate[spec.aggregateMethod]
    : "first";
}

function resolveEmaParams(spec: PathSpec): { period: number; alpha: number } {
  const rawParam =
    spec.parameters.length > 0 ? Number.parseFloat(spec.parameters[0]) : Number.NaN;

  if (Number.isFinite(rawParam) && rawParam > 0 && rawParam < 1) {
    const alpha = rawParam;
    const period = 2 / alpha - 1;
    return { period, alpha };
  }

  const period =
    Number.isFinite(rawParam) && rawParam > 0 ? rawParam : DEFAULT_EMA_PERIOD;
  const alpha = 2 / (period + 1);
  return { period, alpha };
}

function makeArray(d1: number, d2: number): any[][] {
  const arr: any[][] = [];
  for (let i = 0; i < d1; i++) {
    arr.push(new Array(d2));
  }
  return arr;
}

// Builds the `values` descriptor list for a set of path specs, including the
// sourceRef only when one was requested for that path.
function valuesForSpecs(pathSpecs: PathSpec[]): ValueList {
  return pathSpecs.map(({ path, aggregateMethod, sourceRef }: PathSpec) => ({
    path,
    method: aggregateMethod,
    ...(sourceRef ? { sourceRef } : {}),
  }));
}

// In v1, navigation.position is stored as a `jsonValue` JSON string
// {"longitude":...,"latitude":...}. Extract it into a [lon, lat] pair.
function extractPosition(row: any): [number, number] | null {
  if (row.value) {
    try {
      const p = JSON.parse(row.value);
      return [p.longitude, p.latitude];
    } catch (e) {
      return null;
    }
  }
  return null;
}

// Decodes a raw InfluxQL cell value according to the field it was read from.
// `value` and `stringValue`/`boolValue` are returned as-is; `jsonValue` holds a
// JSON-encoded object and is parsed back into the original value.
function decodeValue(raw: any, field?: string): any {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (field === "jsonValue" && typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch (e) {
      return raw;
    }
  }
  return raw;
}

/**
 * History API provider backed by an InfluxDB 1.x instance.
 *
 * Implements the Signal K History API (`@signalk/server-api/history`'s
 * `HistoryApi`) so that the server can serve `/signalk/v2/api/history/*`
 * from data written by this plugin. The structure mirrors the
 * signalk-to-influxdb2 provider, adapted for InfluxDB 1.x InfluxQL and the
 * v1 data model (position stored as `jsonValue`, numerics as `value`).
 */
export class InfluxHistoryProvider implements HistoryApi {
  // Cache of path -> InfluxDB field key, populated lazily via SHOW FIELD KEYS.
  private fieldCache = new Map<string, string>();

  constructor(
    private influxP: Promise<InfluxDB>,
    private selfId: string,
    private debug: (s: string) => void
  ) {}

  // Resolves the InfluxDB field each path stores its values in (via
  // `SHOW FIELD KEYS`), caches the result, and rewrites each path spec's
  // `aggregateFunction` to a selector that is valid for that field. Numeric
  // (`value`) fields keep the requested aggregation; non-numeric fields are
  // restricted to `first`/`last`, and any other method is coerced to `first`.
  private async resolveFields(pathSpecs: PathSpec[]): Promise<void> {
    const uniquePaths = Array.from(
      new Set(
        pathSpecs
          .filter(({ path }) => path !== "navigation.position")
          .map(({ path }) => path)
      )
    );
    if (uniquePaths.length === 0) {
      return;
    }

    const influx = await this.influxP;
    await Promise.all(
      uniquePaths.map(async (path) => {
        const field = await this.discoverField(influx, path);
        pathSpecs.forEach((spec) => {
          if (spec.path === path && spec.path !== "navigation.position") {
            spec.field = field;
            spec.aggregateFunction = aggregateFunctionFor(spec);
          }
        });
      })
    );
  }

  // Returns the InfluxDB field key a measurement stores its values in.
  // `SHOW FIELD KEYS FROM "<path>"` lists the measurement's fields; the v1
  // writer writes exactly one of `value`/`stringValue`/`boolValue`/`jsonValue`
  // per point, so we pick the typed field when present and fall back to
  // `value` (the historic numeric default).
  private async discoverField(
    influx: InfluxDB,
    path: string
  ): Promise<string> {
    const cached = this.fieldCache.get(path);
    if (cached) {
      return cached;
    }
    let field = NUMERIC_FIELD;
    try {
      const rows: any[] = (await influx.query(
        `SHOW FIELD KEYS FROM "${path}"`
      )) as any[];
      const keys = rows.map((r) => r.fieldKey).filter((k: string) =>
        k === NUMERIC_FIELD || (NON_NUMERIC_FIELDS as readonly string[]).includes(k)
      );
      const nonNumeric = keys.find((k: string) => k !== NUMERIC_FIELD);
      if (nonNumeric) {
        field = nonNumeric;
      } else if (keys.includes(NUMERIC_FIELD)) {
        field = NUMERIC_FIELD;
      }
    } catch (e) {
      // Measurement may not exist (no data yet). Assume the numeric default.
      this.debug(`SHOW FIELD KEYS failed for ${path}: ${(e as Error).message}`);
    }
    this.fieldCache.set(path, field);
    return field;
  }

  async getValues(query: ValuesRequest): Promise<ValuesResponse> {
    const { from, to } = getTimeRange(query);
    const context = ((query.context === "vessels.self"
      ? `vessels.${this.selfId}`
      : query.context) || `vessels.${this.selfId}`) as Context;
    const resolution =
      query.resolution || (to.toEpochSecond() - from.toEpochSecond()) / 1000;

    // Convert the server-parsed pathSpecs into the internal format.
    const pathSpecs: PathSpec[] = query.pathSpecs.map((spec) => {
      const sourceRef = (spec as { sourceRef?: SourceRef }).sourceRef;
      return {
        path: spec.path,
        aggregateMethod: spec.aggregate,
        aggregateFunction: functionForAggregate[spec.aggregate] || "mean",
        parameters: spec.parameter || [],
        ...(sourceRef ? { sourceRef } : {}),
      };
    });

    // Discover which InfluxDB field each non-position path stores its values
    // in, then adjust the aggregate function accordingly: only `first`/`last`
    // are meaningful for textual, boolean and JSON values, so any numeric-only
    // method is coerced to `first` for those fields.
    await this.resolveFields(pathSpecs);

    const positionPathSpecs = pathSpecs
      .filter(({ path }) => path === "navigation.position")
      .slice(0, 1);
    const nonPositionPathSpecs = pathSpecs.filter(
      ({ path }) => path !== "navigation.position"
    );
    const needsCollation =
      nonPositionPathSpecs.length > 0 && positionPathSpecs.length > 0;

    // Calculate extended query window for SMA and EMA. Only numeric fields
    // support moving averages; non-numeric specs were coerced to `first`.
    const maxSmaWindow = nonPositionPathSpecs.reduce((max, spec) => {
      if (spec.aggregateMethod === "sma" && isNumericField(spec.field)) {
        const windowSize =
          spec.parameters.length > 0 ? parseInt(spec.parameters[0], 10) : 5;
        return Math.max(max, windowSize);
      }
      return max;
    }, 0);

    const maxEmaWindow = nonPositionPathSpecs.reduce((max, spec) => {
      if (spec.aggregateMethod === "ema" && isNumericField(spec.field)) {
        const { period } = resolveEmaParams(spec);
        return Math.max(max, Math.ceil(period * 4));
      }
      return max;
    }, 0);

    const maxWindow = Math.max(maxSmaWindow, maxEmaWindow);
    const extendedFrom =
      maxWindow > 0
        ? from.minusNanos(maxWindow * resolution * 1000 * 1_000_000)
        : from;

    const positionResult: Promise<DataResult> = positionPathSpecs.length
      ? this.getPositions(
          context,
          from,
          to,
          resolution * 1000,
          needsCollation,
          positionPathSpecs[0].sourceRef
        )
      : Promise.resolve({ values: [], data: [] });

    const nonPositionResult: Promise<DataResult> = nonPositionPathSpecs.length
      ? this.getNumericValues(
          context,
          extendedFrom,
          to,
          resolution * 1000,
          nonPositionPathSpecs,
          needsCollation
        )
      : Promise.resolve({ values: [], data: [] });

    const [posResult, nonPosResult] = await Promise.all([
      positionResult,
      nonPositionResult,
    ]);

    // Apply SMA and EMA post-processing if needed.
    let processedNonPosResult = nonPosResult;
    if (
      (maxSmaWindow > 0 || maxEmaWindow > 0) &&
      nonPosResult.data.length > 0
    ) {
      processedNonPosResult = applyMovingAveragePostProcessing(
        nonPosResult,
        nonPositionPathSpecs,
        from.toString() as Timestamp
      );
    }

    // Collate by timestamp (union of timestamps from both sources), not by row
    // order. This avoids mismatches when one query returns extra rows.
    const data: any[] = [];
    let values: ValueList = [];

    const positionByTs = new Map<string, [number, number] | null>();
    posResult.data.forEach((row: DataRow) => {
      const ts = row[0] as string;
      const pos = row[1];
      if (!Array.isArray(pos)) {
        return;
      }
      const [lon, lat] = pos;
      if (
        (lon === null || lon === undefined) &&
        (lat === null || lat === undefined)
      ) {
        return;
      }
      positionByTs.set(ts, [lon, lat]);
    });

    const numericByTs = new Map<string, (number | null)[]>();
    processedNonPosResult.data.forEach((row: DataRow) => {
      const ts = row[0] as string;
      const numericValues = row.slice(1) as (number | null)[];
      const existing = numericByTs.get(ts);
      if (!existing) {
        numericByTs.set(ts, [...numericValues]);
        return;
      }
      for (let k = 0; k < numericValues.length; k++) {
        if (
          (existing[k] === null || existing[k] === undefined) &&
          numericValues[k] !== null &&
          numericValues[k] !== undefined
        ) {
          existing[k] = numericValues[k];
        }
      }
    });

    // Values list ordering: position (if requested) first, then numeric.
    if (positionPathSpecs.length > 0 && posResult.values.length > 0) {
      values = values.concat(posResult.values);
    }
    if (
      nonPositionPathSpecs.length > 0 &&
      processedNonPosResult.values.length > 0
    ) {
      values = values.concat(processedNonPosResult.values);
    }

    // Union timestamps from both results.
    const tsSet = new Set<string>();
    posResult.data.forEach((r) => tsSet.add(r[0] as string));
    processedNonPosResult.data.forEach((r) => tsSet.add(r[0] as string));
    const timestamps = Array.from(tsSet).sort();

    const numericWidth = nonPositionPathSpecs.length;
    timestamps.forEach((ts) => {
      const row: any[] = [ts];

      if (positionPathSpecs.length > 0) {
        row.push(positionByTs.get(ts) ?? null);
      }
      if (nonPositionPathSpecs.length > 0) {
        const nv = numericByTs.get(ts);
        if (nv) {
          row.push(...nv);
        } else {
          row.push(...new Array(numericWidth).fill(null));
        }
      }

      const hasAnyValue = row.slice(1).some((v) => {
        if (Array.isArray(v)) {
          return v.some((x) => x !== null && x !== undefined);
        }
        return v !== null && v !== undefined;
      });

      if (hasAnyValue) {
        data.push(row);
      }
    });

    return {
      context,
      range: {
        from: from.toString() as Timestamp,
        to: to.toString() as Timestamp,
      },
      values,
      data,
    };
  }

  async getContexts(_query: ContextsRequest): Promise<ContextsResponse> {
    const influx = await this.influxP;
    const result: any = await influx.query(
      'SHOW TAG VALUES FROM "navigation.position" WITH KEY = "context"'
    );
    return result.map((x: any) => x.value);
  }

  async getPaths(_query: PathsRequest): Promise<PathsResponse> {
    const influx = await this.influxP;
    const result: any = await influx.query(`SHOW MEASUREMENTS`);
    return result.map((r: any) => r.name);
  }

  // ---- internal query helpers ----

  private getPositions(
    context: Context,
    from: ZonedDateTime,
    to: ZonedDateTime,
    timeResolutionMillis: number,
    needsCollation: boolean,
    sourceRef?: SourceRef
  ): Promise<DataResult> {
    const sourceClause = sourceRef
      ? `\n    and\n    "source" = '${sourceRef}'`
      : "";

    const query = `
  select
    first(jsonValue) as value
  from
    "navigation.position"
  where
    "context" = '${context}'
    and
    time >= '${from.format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)}Z'
    and
   time <= '${to.format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)}Z'${sourceClause}
  group by time(${timeResolutionMillis}ms)${
      !needsCollation ? " fill(none)" : ""
    }`;

    this.debug(query);

    return this.influxP
      .then((influx) => influx.query(query))
      .then((rows: any[]) => ({
        values: [
          {
            path: "navigation.position" as Path,
            method: "first" as AggregateMethod,
            ...(sourceRef ? { sourceRef } : {}),
          },
        ],
        data: rows.map(
          (row: any) =>
            [row.time.toISOString(), extractPosition(row)] as DataRow
        ),
      }));
  }

  private getNumericValues(
    context: Context,
    from: ZonedDateTime,
    to: ZonedDateTime,
    timeResolutionMillis: number,
    pathSpecs: PathSpec[],
    needsCollation: boolean
  ): Promise<DataResult> {
    const distinctSourceRefs = new Set(pathSpecs.map((ps) => ps.sourceRef));

    // Common case: all paths share a single source (or none). A single query
    // suffices and the result layout is identical to the unfiltered behaviour.
    if (distinctSourceRefs.size <= 1) {
      const sourceRef = pathSpecs[0]?.sourceRef;
      return this.querySourceGroup(
        context,
        from,
        to,
        timeResolutionMillis,
        pathSpecs,
        needsCollation,
        sourceRef
      );
    }

    // Mixed sources: each distinct sourceRef needs its own InfluxQL query (the
    // WHERE clause is global, so different measurements cannot be filtered by
    // different sources in one statement). Run per-source queries and collate
    // the rows by timestamp back into the original column order.
    const groups = new Map<
      string | undefined,
      { specs: PathSpec[]; indices: number[] }
    >();
    pathSpecs.forEach((ps, i) => {
      let group = groups.get(ps.sourceRef);
      if (!group) {
        group = { specs: [], indices: [] };
        groups.set(ps.sourceRef, group);
      }
      group.specs.push(ps);
      group.indices.push(i);
    });

    const groupPromises = Array.from(groups.values()).map((group) =>
      this.querySourceGroup(
        context,
        from,
        to,
        timeResolutionMillis,
        group.specs,
        needsCollation,
        group.specs[0].sourceRef
      ).then((result) => ({ result, indices: group.indices }))
    );

    return Promise.all(groupPromises).then((groupResults) => {
      const tsSet = new Set<string>();
      groupResults.forEach(({ result }) =>
        result.data.forEach((r) => tsSet.add(r[0] as string))
      );
      const allTs = Array.from(tsSet).sort();
      const rowByTs = new Map<string, (number | null)[]>();
      allTs.forEach((ts) => {
        const row: (number | null)[] = new Array(pathSpecs.length + 1).fill(
          null
        );
        (row as any[])[0] = ts;
        rowByTs.set(ts, row);
      });

      groupResults.forEach(({ result, indices }) => {
        result.data.forEach((groupRow) => {
          const ts = groupRow[0] as string;
          const target = rowByTs.get(ts);
          if (!target) {
            return;
          }
          indices.forEach((originalIndex, groupColumn) => {
            target[originalIndex + 1] =
              (groupRow as any[])[groupColumn + 1] ?? null;
          });
        });
      });

      return {
        values: valuesForSpecs(pathSpecs),
        data: allTs.map((ts) => rowByTs.get(ts)) as DataRow[],
      };
    });
  }

  // Runs a single InfluxQL query for path specs that share one source (or
  // none), returning rows in the same column order as `pathSpecs`.
  private querySourceGroup(
    context: Context,
    from: ZonedDateTime,
    to: ZonedDateTime,
    timeResolutionMillis: number,
    pathSpecs: PathSpec[],
    needsCollation: boolean,
    sourceRef?: string
  ): Promise<DataResult> {
    // When every spec reads the numeric `value` field we can use a single
    // multi-measurement query (the original, fast path). When any spec reads a
    // non-numeric field (stringValue/boolValue/jsonValue), InfluxQL's single
    // field list applies to all measurements in a multi-measurement SELECT, so
    // we instead run one query per path and collate the results by timestamp.
    const allNumeric = pathSpecs.every((ps) => isNumericField(ps.field));
    if (!allNumeric) {
      return this.querySourceGroupPerPath(
        context,
        from,
        to,
        timeResolutionMillis,
        pathSpecs,
        needsCollation,
        sourceRef
      );
    }

    const start = Date.now();

    const uniquePaths = pathSpecs.reduce<string[]>((acc, ps) => {
      if (acc.indexOf(ps.path) === -1) {
        acc.push(ps.path);
      }
      return acc;
    }, []);
    const uniqueAggregates = pathSpecs.reduce<string[]>((acc, ps) => {
      if (acc.indexOf(ps.aggregateFunction) === -1) {
        acc.push(ps.aggregateFunction);
      }
      return acc;
    }, []);

    const sourceClause = sourceRef
      ? `\n    and\n    "source" = '${sourceRef}'`
      : "";

    const query = `
  select
    ${uniqueAggregates
      .map((aggregateFunction) => `${aggregateFunction}(${NUMERIC_FIELD})`)
      .join(",")}
  from
    ${uniquePaths.map((s) => `"${s}"`).join(",")}
  where
    "context" = '${context}'
    and
    time >= '${from.format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)}Z'
    and
   time <= '${to.format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)}Z'${sourceClause}
  group by time(${timeResolutionMillis}ms)${
      !needsCollation ? " fill(none)" : ""
    }`;
    this.debug(query);

    return this.influxP
      .then((influx) => influx.query(query))
      .then((result: any) => {
        const rows = result as any[];
        this.debug(`got ${rows.length} rows in ${Date.now() - start}ms`);
        const resultLength = rows.length;
        const resultData = makeArray(resultLength, pathSpecs.length + 1);

        for (let j = 0; j < resultLength; j++) {
          resultData[j][0] = rows[j].time.toISOString();
        }

        result.groups().forEach((group: any) => {
          const groupPathSpecs = pathSpecs.reduce<any[]>((acc, ps, i) => {
            if (ps.path === group.name) {
              acc.push([i + 1, ps.aggregateFunction]);
            }
            return acc;
          }, []);
          group.rows.forEach((row: any, i: number) => {
            groupPathSpecs.forEach(
              ([fieldIndex, fieldName]: [number, string]) => {
                resultData[i][fieldIndex] = row[fieldName];
              }
            );
          });
        });

        this.debug(`rows done ${Date.now() - start}ms`);
        return {
          values: valuesForSpecs(pathSpecs),
          data: resultData as DataRow[],
        };
      });
  }

  // Runs one InfluxQL query per path (single measurement) and collates the
  // results by timestamp into the original column order of `pathSpecs`. Used
  // when one or more specs read a non-numeric field, since InfluxQL applies a
  // single field list across all measurements in a multi-measurement SELECT.
  private querySourceGroupPerPath(
    context: Context,
    from: ZonedDateTime,
    to: ZonedDateTime,
    timeResolutionMillis: number,
    pathSpecs: PathSpec[],
    needsCollation: boolean,
    sourceRef?: string
  ): Promise<DataResult> {
    const sourceClause = sourceRef
      ? `\n    and\n    "source" = '${sourceRef}'`
      : "";
    const fromStr = from.format(DateTimeFormatter.ISO_LOCAL_DATE_TIME);
    const toStr = to.format(DateTimeFormatter.ISO_LOCAL_DATE_TIME);
    const fillClause = !needsCollation ? " fill(none)" : "";

    // Collapse duplicate specs (same path+field+aggregate) into a single query;
    // remember which output columns each query feeds so we can fan values out.
    const perPath = new Map<
      string,
      { spec: PathSpec; indices: number[] }
    >();
    pathSpecs.forEach((ps, i) => {
      const key = `${ps.path}|${ps.field}|${ps.aggregateFunction}`;
      let entry = perPath.get(key);
      if (!entry) {
        entry = { spec: ps, indices: [] };
        perPath.set(key, entry);
      }
      entry.indices.push(i);
    });

    const queryPromises = Array.from(perPath.values()).map(({ spec, indices }) =>
      this.influxP
        .then((influx) =>
          influx.query(`
  select
    ${spec.aggregateFunction}("${spec.field}")
  from
    "${spec.path}"
  where
    "context" = '${context}'
    and
    time >= '${fromStr}Z'
    and
   time <= '${toStr}Z'${sourceClause}
  group by time(${timeResolutionMillis}ms)${fillClause}`)
        )
        .then((rows: any[]) => ({ spec, indices, rows }))
    );

    return Promise.all(queryPromises).then((results) => {
      const tsSet = new Set<string>();
      results.forEach(({ rows }) =>
        rows.forEach((r: any) => tsSet.add(r.time.toISOString()))
      );
      const allTs = Array.from(tsSet).sort();
      const rowByTs = new Map<string, any[]>();
      allTs.forEach((ts) => {
        const row: any[] = new Array(pathSpecs.length + 1).fill(null);
        row[0] = ts;
        rowByTs.set(ts, row);
      });

      results.forEach(({ spec, indices, rows }) => {
        rows.forEach((row: any) => {
          const ts = row.time.toISOString();
          const target = rowByTs.get(ts);
          if (!target) {
            return;
          }
          const decoded = decodeValue(row[spec.aggregateFunction], spec.field);
          indices.forEach((originalIndex) => {
            target[originalIndex + 1] = decoded;
          });
        });
      });

      return {
        values: valuesForSpecs(pathSpecs),
        data: allTs.map((ts) => rowByTs.get(ts)) as DataRow[],
      };
    });
  }
}

// Resolves the from/to ZonedDateTimes from a History API request's time range
// parameters. Supports `from`+`to`, `from`+`duration`, `to`+`duration` and
// `duration` alone (relative to now). Omitted `to` defaults to now.
//
// `query` is cast to `any` because the request types use Temporal.Instant /
// Temporal.Duration (from @js-temporal/polyfill, supplied by the server) which
// we only need to read as strings / millisecond totals here.
function getTimeRange(query: ValuesRequest | PathsRequest | ContextsRequest): {
  from: ZonedDateTime;
  to: ZonedDateTime;
} {
  const q = query as any;

  if (q.duration !== undefined) {
    const durationMs =
      typeof q.duration === "number"
        ? q.duration * 1000
        : q.duration.total("milliseconds");

    if (q.from !== undefined) {
      const from = ZonedDateTime.parse(q.from.toString());
      const to = from.plusNanos(durationMs * 1_000_000);
      return { from, to };
    } else if (q.to !== undefined) {
      const to = ZonedDateTime.parse(q.to.toString());
      const from = to.minusNanos(durationMs * 1_000_000);
      return { from, to };
    } else {
      const to = ZonedDateTime.now(ZoneId.UTC);
      const from = to.minusNanos(durationMs * 1_000_000);
      return { from, to };
    }
  } else if (q.from !== undefined) {
    const from = ZonedDateTime.parse(q.from.toString());
    const to =
      q.to !== undefined
        ? ZonedDateTime.parse(q.to.toString())
        : ZonedDateTime.now(ZoneId.UTC);
    return { from, to };
  }

  throw new Error("Invalid time range parameters");
}

function applyMovingAveragePostProcessing(
  result: DataResult,
  pathSpecs: PathSpec[],
  requestedFromTimestamp: Timestamp
): DataResult {
  const data = result.data;

  const smaIndices = pathSpecs
    .map((spec, idx) => ({ spec, idx }))
    .filter(({ spec }) => spec.aggregateMethod === "sma" && isNumericField(spec.field));
  const emaIndices = pathSpecs
    .map((spec, idx) => ({ spec, idx }))
    .filter(({ spec }) => spec.aggregateMethod === "ema" && isNumericField(spec.field));

  if (smaIndices.length === 0 && emaIndices.length === 0) {
    const requestedFromMs = new Date(requestedFromTimestamp).toISOString();
    const trimmedData = data.filter(
      (row) => (row[0] as string) >= requestedFromMs
    );
    return { values: result.values, data: trimmedData as DataRow[] };
  }

  const processedData = data.map((row) => [...row]);

  // Calculate SMA for each SMA column.
  smaIndices.forEach(({ spec, idx }) => {
    const windowSize =
      spec.parameters.length > 0 ? parseInt(spec.parameters[0], 10) : 5;
    const columnIndex = idx + 1;

    for (let i = 0; i < processedData.length; i++) {
      const startIdx = Math.max(0, i - windowSize + 1);
      const vals: number[] = [];

      for (let j = startIdx; j <= i; j++) {
        const value = data[j][columnIndex];
        if (value !== null && value !== undefined && typeof value === "number") {
          vals.push(value);
        }
      }

      if (vals.length > 0) {
        processedData[i][columnIndex] = vals.reduce((acc, val) => acc + val, 0) / vals.length;
      } else {
        processedData[i][columnIndex] = null;
      }
    }
  });

  // Calculate EMA for each EMA column.
  emaIndices.forEach(({ spec, idx }) => {
    const { period, alpha } = resolveEmaParams(spec);
    const columnIndex = idx + 1;

    // Use 3x period for initial SMA to seed the EMA.
    const initialSmaWindow = Math.max(1, Math.round(period * 3));
    let ema: number | null = null;

    for (let i = 0; i < processedData.length; i++) {
      const currentValue = data[i][columnIndex];

      if (currentValue === null || currentValue === undefined || typeof currentValue !== "number") {
        // Carry forward last EMA when current value is null.
        processedData[i][columnIndex] = ema;
        continue;
      }

      if (ema === null) {
        // Initialize EMA with SMA of first N values.
        if (i >= initialSmaWindow - 1) {
          const startIdx = Math.max(0, i - initialSmaWindow + 1);
          const vals: number[] = [];

          for (let j = startIdx; j <= i; j++) {
            const value = data[j][columnIndex];
            if (value !== null && value !== undefined && typeof value === "number") {
              vals.push(value);
            }
          }

          if (vals.length > 0) {
            ema = vals.reduce((acc, val) => acc + val, 0) / vals.length;
            processedData[i][columnIndex] = ema;
          } else {
            processedData[i][columnIndex] = null;
          }
        } else {
          // Not enough data yet for initial SMA.
          processedData[i][columnIndex] = null;
        }
      } else {
        // EMA_t = α * Value_t + (1 - α) * EMA_{t-1}
        ema = alpha * currentValue + (1 - alpha) * ema;
        processedData[i][columnIndex] = ema;
      }
    }
  });

  // Trim to requested time range.
  const requestedFromMs = new Date(requestedFromTimestamp).toISOString();
  const trimmedData = processedData.filter(
    (row) => (row[0] as string) >= requestedFromMs
  );

  return {
    values: result.values,
    data: trimmedData as DataRow[],
  };
}
