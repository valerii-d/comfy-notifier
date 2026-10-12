// Sends to a forum topic when topicId is set; if Telegram rejects the topic
// (deleted, wrong id), retries in the chat's General topic. Never throws.
async function sendMessage(telegram, chatId, topicId, text, extra = {}) {
  const options = topicId ? { ...extra, message_thread_id: topicId } : extra;
  try {
    return await telegram.sendMessage(chatId, text, options);
  } catch (error) {
    console.error(`Error sending message to ${chatId}${topicId ? `/${topicId}` : ''}:`, error.description || error.message);
    if (!topicId) return null;
    try {
      return await telegram.sendMessage(chatId, text, extra);
    } catch (fallbackError) {
      console.error('Fallback message also failed:', fallbackError.description || fallbackError.message);
      return null;
    }
  }
}

module.exports = { sendMessage };
