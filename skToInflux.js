module.exports = {
  deltaToPointsConverter: (selfContext, recordTrack, shouldStore) => {
    return delta => {
      if (delta.context === 'vessels.self') {
        delta.context = selfContext
      }
      let points = []
      if (delta.updates && delta.context === selfContext) {
        delta.updates.forEach(update => {
          if (update.values) {
            points = update.values.reduce((acc, pathValue) => {
              if (pathValue.path === 'navigation.position') {
                if (
                  recordTrack &&
                  new Date().getTime() - lastPositionStored > 1000
                ) {
                  acc.push({
                    measurement: pathValue.path,
                    fields: {
                      value: JSON.stringify([
                        pathValue.value.longitude,
                        pathValue.value.latitude
                      ])
                    }
                  })
                  lastPositionStored = new Date().getTime()
                }
              } else if (shouldStore(pathValue.path)) {
                if (typeof pathValue.value === 'number') {
                  acc.push({
                    measurement: pathValue.path,
                    fields: {
                      value: pathValue.value
                    }
                  })
                }
              }
              return acc
            }, [])
          }
        })
      }
      return points
    }
  }
}
