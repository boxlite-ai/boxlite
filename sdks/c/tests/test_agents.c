#include "boxlite.h"
#include <assert.h>
#include <stddef.h>
#include <string.h>

static int callbacks = 0;
static void session_cb(struct CAgentSession *session,
                       const CBoxliteError *error, void *data) {
  (void)session;
  (void)error;
  (void)data;
  callbacks++;
}
static void turn_cb(struct CAgentTurn *turn, const CBoxliteError *error,
                    void *data) {
  (void)turn;
  (void)error;
  (void)data;
  callbacks++;
}
static void json_cb(const char *json, const CBoxliteError *error, void *data) {
  (void)json;
  (void)error;
  (void)data;
  callbacks++;
}
static void done_cb(const CBoxliteError *error, void *data) {
  (void)error;
  (void)data;
  callbacks++;
}
#define CHECK_UNIMPLEMENTED(call, operation)                                   \
  do {                                                                         \
    assert((call) == Unsupported);                                             \
    assert(error.code == Unsupported);                                         \
    assert(error.message != NULL);                                             \
    assert(strstr(error.message, operation " is not implemented") != NULL);    \
    boxlite_error_free(&error);                                                \
  } while (0)

int main(void) {
  CBoxliteError error = {0};
  struct CAgentCreateOptions create_options = {.cwd = "/workspace",
                                               .config_json =
                                                   "{\"model\":\"model\"}",
                                               .idempotency_key = "create-1"};
  struct CAgentSendOptions send_options = {.mode = AgentSendReject,
                                           .data_json = "{\"key\":1}",
                                           .idempotency_key = "send-1"};
  struct CAgentWaitOptions wait_options = {.timeout_seconds = 1};
  struct CAgentEventsOptions events_options = {.after = "cursor"};
  struct CAgentHandle *agents = NULL;
  assert(boxlite_box_agents(NULL, &agents, &error) == InvalidArgument);
  assert(agents == NULL);
  boxlite_error_free(&error);
  CHECK_UNIMPLEMENTED(boxlite_agent_create(NULL, "agent", &create_options,
                                           session_cb, NULL, &error),
                      "agents.create");
  CHECK_UNIMPLEMENTED(
      boxlite_agent_get(NULL, "session", session_cb, NULL, &error),
      "agents.get");
  CHECK_UNIMPLEMENTED(
      boxlite_agent_session_close(NULL, NULL, done_cb, NULL, &error),
      "session.close");
  CHECK_UNIMPLEMENTED(boxlite_agent_session_send(NULL, "task", &send_options,
                                                 turn_cb, NULL, &error),
                      "session.send");
  CHECK_UNIMPLEMENTED(
      boxlite_agent_session_get_turn(NULL, "turn", turn_cb, NULL, &error),
      "session.get_turn");
  CHECK_UNIMPLEMENTED(
      boxlite_agent_session_requests(NULL, json_cb, NULL, &error),
      "session.requests");
  CHECK_UNIMPLEMENTED(boxlite_agent_session_respond(
                          NULL, "request",
                          "{\"type\":\"permission\",\"approved\":false}", NULL,
                          turn_cb, NULL, &error),
                      "session.respond");
  CHECK_UNIMPLEMENTED(
      boxlite_agent_turn_wait(NULL, &wait_options, json_cb, NULL, &error),
      "turn.wait");
  CHECK_UNIMPLEMENTED(
      boxlite_agent_turn_steer(NULL, "direction", NULL, json_cb, NULL, &error),
      "turn.steer");
  CHECK_UNIMPLEMENTED(
      boxlite_agent_turn_interrupt(NULL, NULL, done_cb, NULL, &error),
      "turn.interrupt");
  struct CAgentEvents *events = (struct CAgentEvents *)&callbacks;
  CHECK_UNIMPLEMENTED(boxlite_agent_session_events(NULL, &events_options,
                                                   json_cb, NULL, &events,
                                                   &error),
                      "session.events");
  assert(events == NULL);
  events = (struct CAgentEvents *)&callbacks;
  CHECK_UNIMPLEMENTED(
      boxlite_agent_turn_events(NULL, NULL, json_cb, NULL, &events, &error),
      "turn.events");
  assert(events == NULL);
  char *json = (char *)&callbacks;
  CHECK_UNIMPLEMENTED(boxlite_agent_session_state(NULL, &json, &error),
                      "session.state");
  assert(json == NULL);
  json = (char *)&callbacks;
  CHECK_UNIMPLEMENTED(boxlite_agent_session_config(NULL, &json, &error),
                      "session.config");
  assert(json == NULL);
  json = (char *)&callbacks;
  CHECK_UNIMPLEMENTED(boxlite_agent_session_capabilities(NULL, &json, &error),
                      "session.capabilities");
  assert(json == NULL);
  json = (char *)&callbacks;
  CHECK_UNIMPLEMENTED(boxlite_agent_turn_state(NULL, &json, &error),
                      "turn.state");
  assert(json == NULL);
  assert(callbacks == 0);
  boxlite_agent_free(NULL);
  boxlite_agent_session_free(NULL);
  boxlite_agent_turn_free(NULL);
  boxlite_agent_events_free(NULL);
  return 0;
}
