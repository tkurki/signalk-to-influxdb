import Debug from "debug";

import {
  NextFunction,
  Request,
  RequestHandler,
  Response,
  Router
} from "express";
import { ZonedDateTime } from "js-joda";
import { InfluxDB, IResults } from "influx";
const contextsDebug = Debug("influxdb:history:contexts");
const pathsDebug = Debug("influxdb:history:paths");
const valuesDebug = Debug("influxdb:history:values");

export function registerHistoryApiRoute(router: Router, influx: InfluxDB) {
  router.get(
    "/values",
    asyncHandler(
      fromToHandler(
        (...args) => getValues.apply(this, [influx, ...args]),
        valuesDebug
      )
    )
  );
}

// export default function setupHistoryAPIRoutes(app: Express) {
//   app.get(
//     "/signalk/v1/history/contexts",
//     asyncHandler(fromToHandler(getContexts, contextsDebug))
//   );
//   app.get(
//     "/signalk/v1/history/paths",
//     asyncHandler(fromToHandler(getPaths, pathsDebug))
//   );
// }

// const influx = new InfluxDB({
//   host: "localhost",
//   port: 8086,
//   database: "signalk"
// });
// const _getValues = (...args) => {
//   console.log(args);
//   console.log([influx, args]);
//   return getValues.apply(this, [influx, ...args]);
// };

// _getValues(
//   ZonedDateTime.parse("2020-01-18T00:08:01Z"),
//   ZonedDateTime.parse("2020-07-01T00:00:02Z"),
//   valuesDebug,
//   {
//     query: {
//       resolution: 1000,
//       paths: "navigation.speedOverGround,environment.depth.belowTransducer"
//     }
//   }
// ).then(d => console.log(JSON.stringify(d, null, 2)));

// type ContextResultRow = [string];
// async function getContexts(
//   influx: InfluxDB,
//   from: ZonedDateTime,
//   to: ZonedDateTime,
//   debug: (s: string) => void
// ) {
//   const coreQuery = ["value", "trackpoint"]
//     .map(
//       table => `
//       SELECT
//         DISTINCT context
//       FROM ${table}
//       WHERE
//         ts >= ${from.toEpochSecond()}
//         AND
//         ts <= ${to.toEpochSecond()}
//     `
//     )
//     .join(" UNION ALL ");
//   const distinctQuery = `SELECT DISTINCT context from (${coreQuery})`;
//   debug(distinctQuery);
//   return ch
//     .querying<ContextResultRow>(distinctQuery)
//     .then((result: any) => result.data.map((row: any[]) => row[0]));
// }

// type PathsResultRow = [string];
// async function getPaths(
//   influx: InfluxDB,
//   from: ZonedDateTime,
//   to: ZonedDateTime,
//   debug: (s: string) => void,
//   req: Request
// ) {
//   const context = req.query.context || "";
//   const query = `
//       SELECT
//         DISTINCT path
//       FROM value
//       WHERE
//         context = '${context}'
//         AND
//         ts >= ${from.toEpochSecond()}
//         AND
//         ts <= ${to.toEpochSecond()}
//     `;
//   debug(query);
//   return ch
//     .querying<PathsResultRow>(query)
//     .then((result: any) => result.data.map((row: any[]) => row[0]));
// }

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
  from: ZonedDateTime,
  to: ZonedDateTime,
  debug: (s: string) => void,
  req: Request
): Promise<ValuesResult | void> {
  const timeResolutionSeconds = req.query.resolution
    ? Number.parseFloat(req.query.resolution)
    : (to.toEpochSecond() - from.toEpochSecond()) / 500;
  const context = req.query.context || "";

  const pathExpressions = (req.query.paths || "")
    .replace(/[^0-9a-z\.,\:]/gi, "")
    .split(",");
  const pathSpecs: PathSpec[] = pathExpressions.map(splitPathExpression);
  const queries = pathSpecs.map(
    ({ aggregateFunction, path }) => `
      SELECT
        ${aggregateFunction} as value
      FROM
      "${path}"
      WHERE
        "context" = 'vessels.urn:mrn:signalk:uuid:c0d79334-4e25-4245-8892-54e8ccc8021d'
        AND
        time > '${from.toString()}' and time <= '${to.toString()}'
      GROUP BY
        time(${Number(timeResolutionSeconds * 1000).toFixed(0)}ms)`
  );

  debug(queries.toString());

  const x: Promise<IResults<any>[]> = Promise.all(
    queries.map((q: string) => influx.then(i => i.query(q)))
  );

  return x.then((results: IResults<any>[]) => ({
    context,
    values: pathSpecs.map(({ path, aggregateMethod }) => ({
      path,
      method: aggregateMethod,
      source: null
    })),
    range: { from: from.toString(), to: to.toString() },
    data: toDataRows(results.map(r => r.groups()))
  }));
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
  >
): ValuesResultRow[] => {
  const resultRows: any[][] = [];
  dataResults.forEach((data, seriesIndex) => {
    const series = data[0]; //we always get one result
    series.rows.forEach((row, i) => {
      if (!resultRows[i]) {
        resultRows[i] = [];
      }
      resultRows[i][0] = row.time.toNanoISOString();
      resultRows[i][seriesIndex + 1] = row.value;
    });
  });
  return resultRows;

  // let lastRow: any;
  // let lastTimestamp = "";
  // return data.reduce((acc: any, valueRow: any[]) => {
  //   const pathIndex = paths.indexOf(valueRow[1]) + 1;
  //   if (valueRow[0] !== lastTimestamp) {
  //     if (lastRow) {
  //       acc.push(lastRow);
  //     }
  //     lastTimestamp = valueRow[0];
  //     // tslint:disable-next-line: radix
  //     lastRow = [new Date(Number.parseInt(lastTimestamp) * 1000)];
  //   }
  //   lastRow[pathIndex] = valueRow[2];
  //   return acc;
  // }, []);
};

interface PathSpec {
  path: string;
  aggregateMethod: string;
  aggregateFunction: string;
}

function splitPathExpression(pathExpression: string): PathSpec {
  const parts = pathExpression.split(":");
  const aggregateMethod = parts[1] || "average";
  return {
    path: parts[0],
    aggregateMethod,
    aggregateFunction: functionForAggregate[aggregateMethod] || "MEAN(value)"
  };
}

const functionForAggregate = {
  average: "MEAN(value)",
  min: "MIN(value)",
  max: "MAX(value)"
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
    contextsDebug(`${from.toString()}-${to.toString()}`);
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
