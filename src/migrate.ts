import {MikroORM} from '@mikro-orm/postgresql';
import config from './mikro-orm.config.js';

// Release-step runner (not part of app boot): node dist/migrate.js up|down|status
const command = process.argv[2];
const orm = await MikroORM.init(config);
try {
    if (command === 'up') await orm.migrator.up();
    else if (command === 'down') await orm.migrator.down();   // reverts the last migration only
    else if (command === 'status') console.log('pending:', (await orm.migrator.getPending()).map(m => m.name));
    else throw new Error(`usage: migrate.js up|down|status (got "${command}")`);
} finally {
    await orm.close();
}
