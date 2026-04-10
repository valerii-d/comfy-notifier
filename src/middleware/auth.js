const { Markup } = require('telegraf');

const isAdmin = (state, ctx) => {
  return state.admins.has(ctx.from.id);
};

const isGroupTopic = (ctx) => {
  return (ctx.chat.type === 'supergroup' || ctx.chat.type === 'group') && ctx.message?.is_topic_message;
};

module.exports = { isAdmin, isGroupTopic };
