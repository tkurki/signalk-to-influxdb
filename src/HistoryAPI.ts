import { DateTimeFormatter, ZonedDateTime } from "@js-joda/core";
//import Debug from "debug";

import {
  NextFunction,
  Request,
  RequestHandler,
  Response,
  Router,
} from "express";
import { InfluxDB, IResults } from "influx";

export function registerHistoryApiRoute(
  router: Router,
  influx: InfluxDB,
  selfId: string,
  debug: (any) => void
) {
  router.get(
    "/signalk/v1/history/values",
    asyncHandler(
      fromToHandler(
        (...args) => getValues.apply(this, [influx, selfId, ...args]),
        debug
      )
    )
  );
  router.get(
    "/signalk/v1/history/contexts",
    asyncHandler(
      fromToHandler(
        (...args) => getContexts.apply(this, [influx, selfId, ...args]),
        debug
      )
    )
  );
  router.get(
    "/signalk/v1/history/paths",
    asyncHandler(
      fromToHandler(
        (...args) => getPaths.apply(this, [influx, selfId, ...args]),
        debug
      )
    )
  );
}

async function getContexts(
  influx: Promise<InfluxDB>,
  from: ZonedDateTime,
  to: ZonedDateTime,
  debug: (s: string) => void
): Promise<string[]> {
  return influx
    .then((i) =>
      i.query('SHOW TAG VALUES FROM "navigation.position" WITH KEY = "context"')
    )
    .then((x: any) => x.map((x) => x.value));
}

async function getPaths(
  influx: Promise<InfluxDB>,
  from: ZonedDateTime,
  to: ZonedDateTime,
  debug: (s: string) => void,
  req: Request
): Promise<string[]> {
  const query = `SHOW MEASUREMENTS`;
  console.log(query);
  return influx
    .then((i) => i.query(query))
    .then((d) => d.map((r: any) => r.name));
}

interface ValuesResult {
  context: string;
  range: {
    from: string;
    to: string;
  };
  values: {
    path: string;
    method: string;
    source?: string;
  }[];
  data: ValuesResultRow[];
}

type ValuesResultRow = any[];

async function getValues(
  influx: Promise<InfluxDB>,
  selfId: string,
  from: ZonedDateTime,
  to: ZonedDateTime,
  debug: (s: string) => void,
  req: Request
): Promise<ValuesResult | void> {
  const timeResolutionSeconds = req.query.resolution
    ? Number.parseFloat(req.query.resolution)
    : (to.toEpochSecond() - from.toEpochSecond()) / 500;

  const context = getContext(req.query.context, selfId);
  debug(context);
  const pathExpressions = (req.query.paths || "")
    .replace(/[^0-9a-z\.,\:]/gi, "")
    .split(",");
  const pathSpecs: PathSpec[] = pathExpressions.map(splitPathExpression);
  const queries = pathSpecs
    .map(
      ({ aggregateFunction, path }) => `
      SELECT
        ${aggregateFunction} as value
      FROM
      "${path}"
      WHERE
        "context" = '${context}'
        AND
        time > '${from.format(
          DateTimeFormatter.ISO_LOCAL_DATE_TIME
        )}Z' and time <= '${to.format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)}Z'
      GROUP BY
        time(${Number(timeResolutionSeconds * 1000).toFixed(0)}ms)`
    )
    .map((s) => s.replace(/\n/g, " ").replace(/ +/g, " "));
  queries.forEach((s) => debug(s));

  const x: Promise<IResults<any>[]> = Promise.all(
    queries.map((q: string) => influx.then((i) => i.query(q)))
  );

  return x.then((results: IResults<any>[]) => ({
    context,
    values: pathSpecs.map(({ path, aggregateMethod }) => ({
      path,
      method: aggregateMethod,
      source: null,
    })),
    range: { from: from.toString(), to: to.toString() },
    data: toDataRows(
      results.map((r) => r.groups()),
      pathSpecs.map((ps) => ps.extractValue)
    ),
  }));
}

function getContext(contextFromQuery: string, selfId: string) {
  if (
    !contextFromQuery ||
    contextFromQuery === "vessels.self" ||
    contextFromQuery === "self"
  ) {
    return `vessels.${selfId}`;
  }
  return contextFromQuery.replace(/ /gi, "");
}

const toDataRows = <
  T extends {
    time: any;
    value: number;
  }
>(
  dataResults: Array<
    {
      name: string;
      rows: T[];
    }[]
  >,
  valueMappers
): ValuesResultRow[] => {
  const resultRows: any[][] = [];
  dataResults.forEach((data, seriesIndex) => {
    const series = data[0]; //we always get one result
    const valueMapper = valueMappers[seriesIndex];
    series &&
      series.rows.forEach((row, i) => {
        if (!resultRows[i]) {
          resultRows[i] = [];
        }
        resultRows[i][0] = row.time.toNanoISOString();
        resultRows[i][seriesIndex + 1] = valueMapper(row);
      });
  });
  return resultRows;
};

interface PathSpec {
  path: string;
  aggregateMethod: string;
  aggregateFunction: string;
  extractValue: (x: any) => any;
}

const EXTRACT_POSITION = (r) => {
  if (r.value) {
    const position = JSON.parse(r.value);
    return [position.longitude, position.latitude];
  }
  return null;
};
const EXTRACT_NUMBER = (r) => r.value;

function splitPathExpression(pathExpression: string): PathSpec {
  const parts = pathExpression.split(":");
  let aggregateMethod = parts[1] || "average";
  let extractValue = EXTRACT_NUMBER;
  if (parts[0] === "navigation.position") {
    aggregateMethod = "first";
    extractValue = EXTRACT_POSITION;
  }
  return {
    path: parts[0],
    aggregateMethod,
    extractValue,
    aggregateFunction: functionForAggregate[aggregateMethod] || "MEAN(value)",
  };
}

const functionForAggregate = {
  average: "MEAN(value)",
  min: "MIN(value)",
  max: "MAX(value)",
  first: "FIRST(jsonValue)",
};

type FromToHandler<T = any> = (
  from: ZonedDateTime,
  to: ZonedDateTime,
  debug: (d: string) => void,
  req: Request
) => Promise<T>;

function fromToHandler(
  wrappedHandler: FromToHandler,
  debug: (d: string) => void
) {
  return async (req: Request, res: Response) => {
    debug(req.query);
    const from = dateTimeFromQuery(req, "from");
    const to = dateTimeFromQuery(req, "to");
    debug(`${from.toString()}-${to.toString()}`);
    res.json(await wrappedHandler(from, to, debug, req));
  };
}

function dateTimeFromQuery(req: Request, paramName: string): ZonedDateTime {
  return ZonedDateTime.parse(req.query[paramName]);
}

function asyncHandler<T>(
  requestHandler: (req: Request, res: Response) => Promise<T>
): RequestHandler {
  return (req2: Request, res2: Response, next: NextFunction) => {
    requestHandler(req2, res2).catch(next);
  };
}
