import {Test, TestingModuleBuilder} from '@nestjs/testing';
import request from 'supertest';
import {AppModule} from '../../src/app.module.js';
import {configureApp} from '../../src/http/configureApp.js';

// Boots the real AppModule. `customize` is for failure injection (`b.overrideProvider(X).useValue(...)`).
// configureApp is the same call main.ts makes, so tests and production share one setup.
export async function createTestApp(customize?: (builder: TestingModuleBuilder) => TestingModuleBuilder) {
    let builder = Test.createTestingModule({imports: [AppModule]});
    if (customize) builder = customize(builder);
    const app = (await builder.compile()).createNestApplication();
    configureApp(app);
    await app.init();
    return {app, http: request(app.getHttpServer())};
}
