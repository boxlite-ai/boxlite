#include "boxlite.h"
#include <assert.h>
#include <stddef.h>
#include <string.h>

static int callbacks = 0;
static void agent_cb(struct CAgent *agent, const CBoxliteError *error,
                     void *data) {
  (void)agent;
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
  struct CAgents *agents = NULL;
  assert(boxlite_box_agents(NULL, &agents, &error) == InvalidArgument);
  assert(agents == NULL);
  boxlite_error_free(&error);
  CHECK_UNIMPLEMENTED(boxlite_agents_create(NULL, "agent", &create_options,
                                            agent_cb, NULL, &error),
                      "agents.create");
  CHECK_UNIMPLEMENTED(boxlite_agents_get(NULL, "agent", agent_cb, NULL, &error),
                      "agents.get");
  CHECK_UNIMPLEMENTED(boxlite_agent_close(NULL, NULL, done_cb, NULL, &error),
                      "agent.close");
  CHECK_UNIMPLEMENTED(
      boxlite_agent_send(NULL, "task", &send_options, turn_cb, NULL, &error),
      "agent.send");
  CHECK_UNIMPLEMENTED(
      boxlite_agent_get_turn(NULL, "turn", turn_cb, NULL, &error),
      "agent.get_turn");
  CHECK_UNIMPLEMENTED(boxlite_agent_requests(NULL, json_cb, NULL, &error),
                      "agent.requests");
  CHECK_UNIMPLEMENTED(
      boxlite_agent_respond(NULL, "request",
                            "{\"type\":\"permission\",\"approved\":false}",
                            NULL, turn_cb, NULL, &error),
      "agent.respond");
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
  CHECK_UNIMPLEMENTED(boxlite_agent_events(NULL, &events_options, json_cb, NULL,
                                           &events, &error),
                      "agent.events");
  assert(events == NULL);
  events = (struct CAgentEvents *)&callbacks;
  CHECK_UNIMPLEMENTED(
      boxlite_agent_turn_events(NULL, NULL, json_cb, NULL, &events, &error),
      "turn.events");
  assert(events == NULL);
  char *json = (char *)&callbacks;
  CHECK_UNIMPLEMENTED(boxlite_agent_state(NULL, &json, &error), "agent.state");
  assert(json == NULL);
  json = (char *)&callbacks;
  CHECK_UNIMPLEMENTED(boxlite_agent_config(NULL, &json, &error),
                      "agent.config");
  assert(json == NULL);
  json = (char *)&callbacks;
  CHECK_UNIMPLEMENTED(boxlite_agent_capabilities(NULL, &json, &error),
                      "agent.capabilities");
  assert(json == NULL);
  json = (char *)&callbacks;
  CHECK_UNIMPLEMENTED(boxlite_agent_turn_state(NULL, &json, &error),
                      "turn.state");
  assert(json == NULL);
  assert(callbacks == 0);
  boxlite_agents_free(NULL);
  boxlite_agent_free(NULL);
  boxlite_agent_turn_free(NULL);
  boxlite_agent_events_free(NULL);
  return 0;
}
