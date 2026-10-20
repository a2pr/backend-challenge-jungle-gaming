import {MikroORM} from '@mikro-orm/postgresql';

export default async function setup() {
    const orm = await MikroORM.init({
        clientUrl: process.env.DATABASE_URL,
        entities: [],
        discovery: {warnWhenNoEntities: false}
    });
    await orm.schema.ensureDatabase(); // creates the DB if missing. Verify this name in the v7 docs
    await orm.close();
}