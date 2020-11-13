exports.up = function(knex) {
  return knex.schema
  .raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
  .dropTableIfExists('users')
  .createTable('users', function (table) {
    table.uuid('customid').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('id').notNullable();
    table.json('data').notNullable();
  });
};

exports.down = function(knex) {
  return knex.schema
    .dropTableIfExists('users');
};