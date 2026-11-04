import { Module } from '@nestjs/common'
import { BoxModule } from '../box/box.module'
import { BoxliteRestModule } from '../boxlite-rest/boxlite-rest.module'
import { OrganizationModule } from '../organization/organization.module'
import { ApiKeyModule } from '../api-key/api-key.module'
import { AuthModule } from '../auth/auth.module'
import { UserModule } from '../user/user.module'
import { EncryptionModule } from '../encryption/encryption.module'
import { CloudAppService } from './cloud-app.service'
import { CloudAppResources } from './cloud-app-resources'
import { CloudAppSourceStore } from './cloud-app-source-store'
import { CloudAppCredentials } from './cloud-app-credentials'
import { CloudAppDomains } from './cloud-app-domains'
import { CloudAppController } from './cloud-app.controller'
import { CloudAppInternalController } from './cloud-app-internal.controller'
import { CloudAppWorker } from './cloud-app-worker'
import { CloudAppWebsocket } from './cloud-app-websocket'

@Module({
  imports: [BoxModule, BoxliteRestModule, OrganizationModule, ApiKeyModule, AuthModule, UserModule, EncryptionModule],
  providers: [
    CloudAppService,
    CloudAppResources,
    CloudAppSourceStore,
    CloudAppCredentials,
    CloudAppDomains,
    CloudAppWorker,
    CloudAppWebsocket,
  ],
  controllers: [CloudAppController, CloudAppInternalController],
  exports: [CloudAppService, CloudAppWebsocket],
})
export class CloudAppModule {}
