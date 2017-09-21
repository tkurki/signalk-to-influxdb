/*
 * Copyright 2017 Teppo Kurki <teppo.kurki@iki.fi>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const Bacon = require('baconjs')
const debug = require('debug')('signalk:signalk-to-influxdb')
const db = require('sqlite')
const geohash = require('ngeohash')

module.exports = { createTrackDb }

function createTrackDb (app) {
  let trackDb
  let unsubscribes = []

  return {
    start: function (options) {
      debug('start')
      db
        .open('track.sqlite')
        .then(opened => {
          debug('track db opened')
          trackDb = opened
          return trackDb.run(
            `
            CREATE TABLE IF NOT EXISTS trackdata(
              track number NOT NULL,
              timestamp number NOT NULL,
              geohash text NOT NULL,
              latitude number NOT NULL,
              longitude number NOT NULL
            )`
          )
        })
        .then(_ => {
          return trackDb.run(
            `
            CREATE TABLE IF NOT EXISTS track(
              id INTEGER PRIMARY KEY,
              name text
            )`
          )
        })
        .then(_ => {
          let lastWrite = 0
          let trackId
          let minInterval = 60 * 1000
          const trackCutoffInterval = 20 * 60 * 1000
          unsubscribes.push(
            app.streambundle
              .getSelfBus('navigation.position')
              .onValue(value => {
                let current = Date.parse(value.timestamp)
                if (current - lastWrite > minInterval) {
                  let trackIdP =
                    !trackId || current - lastWrite > trackCutoffInterval
                      ? newTrackId(trackDb, value.timestamp)
                      : Promise.resolve(trackId)

                  lastWrite = current

                  trackIdP.then(theTrackId => {
                    trackId = theTrackId
                    trackDb
                      .prepare(
                        `INSERT INTO trackdata(track, timestamp, geohash, latitude, longitude) 
                         VALUES(:track, :timestamp, :geohash, :latitude, :longitude)`,
                      {
                        ':track': theTrackId,
                        ':timestamp': current,
                        ':geohash': geohash.encode(
                            value.value.latitude,
                            value.value.longitude
                          ),
                        ':latitude': JSON.stringify(value.value.latitude),
                        ':longitude': JSON.stringify(value.value.longitude)
                      }
                      )
                      .then(stmt => stmt.run())
                      .catch(error => {
                        console.error(error)
                      })
                  })
                }
              })
          )
        })
        .catch(error => {
          console.error(error)
        })
    },
    stop: function () {
      if (trackDb) {
        trackDb.close().then(_ => {
          debug('track db closed')
          track = undefined
        })
      }
    },
    getPeriods: function (bboxString) {
      return getPeriods(_ => trackDb, boundsToHashes(bboxString))
    }
  }
}

function getPeriods (trackDb, geohashes) {
  return getTrackData(trackDb, geohashes)
    .then(splitToTrackSegments)
    .then(trackSegments => {
      return Promise.resolve(trackSegments.map(toPeriod))
    })
}

function toPeriod (rows) {
  return {
    start: new Date(rows[0].timestamp).toISOString(),
    end: new Date(rows[rows.length - 1].timestamp + 60 * 1000).toISOString()
  }
}

// @bboxString southwest_lng,southwest_lat,northeast_lng,northeast_lat
function boundsToHashes (bboxString) {
  const bbox = bboxString.split(',')
  let result = []
  let precision = 0
  let hashes = []
  while (++precision <= 9 && hashes.length <= 32) {
    result = hashes
    hashes = geohash.bboxes(bbox[1], bbox[0], bbox[3], bbox[2], precision)
  }
  return result
}

function splitToTrackSegments (rows) {
  try {
    let lastMillis = 0
    let currentTrackRows
    const threshold = 5 * 60 * 1000
    const result = rows.reduce((acc, row) => {
      if (row.timestamp - lastMillis > threshold) {
        if (typeof currentTrackRows !== 'undefined') {
          acc.push(currentTrackRows)
        }
        currentTrackRows = []
      }
      lastMillis = row.timestamp
      currentTrackRows.push(row)
      return acc
    }, [])
    if (typeof currentTrackRows !== 'undefined') {
      result.push(currentTrackRows)
    }
    return Promise.resolve(result)
  } catch (err) {
    console.error(err)
  }
}

function getTrackData (getTrackDb, hashes) {
  const trackDb = getTrackDb()
  if (trackDb) {
    const query = `
        SELECT * from trackdata
        where ${hashesToWhereClause(hashes)}
        ORDER BY timestamp
      `
    return trackDb.all(query)
  }
  return Promise.resolve([])
}

function hashesToWhereClause (hashes) {
  const result = hashes.map(hash => `geohash like '${hash}%'`).join(' OR ')
  debug(result)
  return result
}

function newTrackId (trackDb, name) {
  return trackDb
    .run(`INSERT INTO track(name) values('${name}')`)
    .then(_ => trackDb.get('SELECT max(id) FROM track'))
    .then(row => Promise.resolve(row['max(id)']))
}
