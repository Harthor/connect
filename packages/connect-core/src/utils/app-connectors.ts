import { Network } from '@aragon/connect-types'
import { ConnectionContext } from '../types'
import { ErrorInvalidConnector, ErrorInvalidApp } from '../errors'
import App from '../entities/App'

type AppConnectContext = {
  app: App
  config: object
  connector: string
  ipfs: ConnectionContext['ipfs']
  network: Network
  orgConnector: ConnectionContext['orgConnector']
  verbose: boolean
}

function normalizeConnectorConfig<Config extends object>(
  connector: string | [string, Config | undefined]
): [string, Config] {
  if (Array.isArray(connector)) {
    // Returning `{} as Config` shouldn’t be an issue, because the config type
    // of an app connector should have all its properties declared as optional.
    return [connector[0], connector[1] ?? ({} as Config)]
  }
  if (typeof connector === 'string') {
    return [connector, {} as Config]
  }
  throw new ErrorInvalidConnector(
    'The connector should be passed as a string or an array.'
  )
}

// Check if an app is valid. We are not using instanceof here, because the
// passed app might come from the final app dependency, while @connect-core
// might come from the app connector they are using, with two different
// versions. It also makes it easier to work with linked dependencies, as it
// creates the same kind of issues.
function isAppValid(app: any): boolean {
  return app && app.name && app.address && app.appId && app.version
}

type AugmentedApp<T> = App &
  T & {
    _app: App
    _connectedApp: T
  }

export function createAppConnector<
  ConnectedApp extends object,
  Config extends object
>(
  callback: (
    context: { config: Config } & AppConnectContext
  ) => ConnectedApp | Promise<ConnectedApp>
) {
  return async function connect(
    app: App | Promise<App>,
    connector?: string | [string, Config | undefined]
  ): Promise<AugmentedApp<ConnectedApp>> {
    app = (await app) as App

    if (!isAppValid(app)) {
      throw new ErrorInvalidApp(
        `App connector: the passed value doesn’t appear to be an App.`
      )
    }

    const { connection } = app.organization
    const { orgConnector } = connection

    // App connector config.
    const [connectorName, connectorConfig] = normalizeConnectorConfig<Config>(
      // Contrary to the main connect() function, app connectors don’t require
      // the connector to be passed. In this case, the name of the org
      // connector (e.g. `name`) is used instead.
      connector || orgConnector.name
    )

    const connectedApp = await callback({
      app,
      config: connectorConfig,
      connector: connectorName,
      ipfs: connection.ipfs,
      network: orgConnector.network,
      orgConnector,
      verbose: connection.verbose,
    })

    const boundMethods = new WeakMap()

    const proxiedApp = new Proxy(connectedApp, {
      get: (target: ConnectedApp, key: string | symbol) => {
        const isAppProperty =
          (connectedApp as any)[key as keyof ConnectedApp] === undefined

        // Pick properties from ConnectedApp first, then App
        const instance = (isAppProperty ? app : connectedApp) as any

        // Bind methods as they get accessed (so `this` works as expected).
        // This is done once for reference comparisons to work as expected.
        if (
          typeof instance[key] === 'function' &&
          !boundMethods.has(instance[key])
        ) {
          instance[key] = instance[key].bind(instance)
          boundMethods.set(instance[key], true)
        }

        return instance[key]
      },
    }) as AugmentedApp<ConnectedApp>

    // Useful for inspection
    proxiedApp._app = app
    proxiedApp._connectedApp = connectedApp

    return proxiedApp
  }
}
