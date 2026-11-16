/* Real-VM C agent acceptance. The Rust runner supplies a scripted model. */
#include "boxlite.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct Seen {
  int done;
  BoxliteErrorCode code;
  int exit_code;
  CBoxHandle *box;
  struct CAgent *agent;
  struct CAgentTurn *turn;
  struct CAgentEvents *stream;
  int opened;
  int terminal;
  int event_received;
  BoxliteErrorCode terminal_error;
  char *first_event;
  char *result;
  char message[512];
} Seen;

static void record_error(Seen *s, const CBoxliteError *error) {
  s->code = error ? error->code : Ok;
  if (error && error->message) {
    snprintf(s->message, sizeof(s->message), "%s", error->message);
  }
}
static void on_box(CBoxHandle *box, CBoxliteError *error, void *data) {
  Seen *s = data;
  s->box = box;
  record_error(s, error);
  s->done = 1;
}
static void on_done(CBoxliteError *error, void *data) {
  Seen *s = data;
  record_error(s, error);
  s->done = 1;
}
static void on_wait(int exit_code, CBoxliteError *error, void *data) {
  Seen *s = data;
  s->exit_code = exit_code;
  record_error(s, error);
  s->done = 1;
}
static void on_agent(struct CAgent *agent, const CBoxliteError *error,
                     void *data) {
  Seen *s = data;
  s->agent = agent;
  record_error(s, error);
  s->done = 1;
}
static void on_turn(struct CAgentTurn *turn, const CBoxliteError *error,
                    void *data) {
  Seen *s = data;
  s->turn = turn;
  record_error(s, error);
  s->done = 1;
}
static void on_open(struct CAgentEvents *stream, const CBoxliteError *error,
                    void *data) {
  Seen *s = data;
  s->stream = stream;
  record_error(s, error);
  s->opened = 1;
}
static void on_event(const char *json, const CBoxliteError *error, void *data) {
  Seen *s = data;
  if (!json) {
    s->terminal++;
    s->terminal_error = error ? error->code : Ok;
    return;
  }
  if (!s->first_event) {
    s->first_event = strdup(json);
    assert(s->first_event);
    s->event_received = 1;
  }
}
static void on_json(const char *json, const CBoxliteError *error, void *data) {
  Seen *s = data;
  record_error(s, error);
  if (json) {
    free(s->result);
    s->result = strdup(json);
    assert(s->result);
  }
  s->done = 1;
}
static void drain_until(CBoxliteRuntime *rt, const int *done) {
  CBoxliteError error = {0};
  for (int i = 0; i < 600 && !*done; i++) {
    assert(boxlite_runtime_drain(rt, 500, &error) >= 0);
    boxlite_error_free(&error);
  }
  assert(*done);
}
static void wait_ok(CBoxliteRuntime *rt, Seen *s) {
  drain_until(rt, &s->done);
  if (s->code != Ok) {
    char diagnostic[sizeof(s->message) + 64];
    snprintf(diagnostic, sizeof(diagnostic), "callback failed: %d %s\n",
             s->code, s->message);
    fputs(diagnostic, stderr);
  }
  assert(s->code == Ok);
  s->done = 0;
}
static void run_shell(CBoxliteRuntime *rt, CBoxHandle *box,
                      const char *script) {
  const char *args[] = {"-c", script};
  BoxliteCommand command = {.command = "sh", .args = args, .argc = 2};
  CBoxliteError error = {0};
  CExecutionHandle *exec = NULL;
  Seen s = {0};
  assert(boxlite_box_exec(box, &command, &exec, &error) == Ok);
  assert(boxlite_execution_wait(exec, on_wait, &s, &error) == Ok);
  wait_ok(rt, &s);
  assert(s.exit_code == 0);
  boxlite_execution_free(exec);
  boxlite_error_free(&error);
}
static void copy_in(CBoxliteRuntime *rt, CBoxHandle *box, const char *src,
                    const char *dst) {
  CBoxliteError error = {0};
  Seen s = {0};
  assert(boxlite_copy_into(box, src, dst, on_done, &s, &error) == Ok);
  wait_ok(rt, &s);
  boxlite_error_free(&error);
}

int main(int argc, char **argv) {
  assert(argc ==
         5); /* binary, provider configuration, runtime home, registry */
  BoxliteImageRegistry registry = {
      .host = argv[4], .transport = BoxliteRegistryTransportHttp, .search = 1};
  CBoxliteError error = {0};
  CBoxliteRuntime *rt = NULL;
  CBoxliteOptions *options = NULL;
  Seen s = {0};
  assert(boxlite_runtime_new(argv[3], &registry, 1, &rt, &error) == Ok);
  assert(boxlite_options_new("debian:bookworm-slim", &options, &error) == Ok);
  boxlite_options_set_auto_delete_interval(options, 0);
  assert(boxlite_create_box(rt, options, on_box, &s, &error) == Ok);
  wait_ok(rt, &s);
  assert(s.box);
  assert(boxlite_start_box(s.box, on_done, &s, &error) == Ok);
  wait_ok(rt, &s);
  run_shell(rt, s.box, "mkdir -p /root/.config/opencode");
  copy_in(rt, s.box, argv[1], "/usr/local/bin/opencode");
  copy_in(rt, s.box, argv[2], "/root/.config/opencode/opencode.json");
  run_shell(rt, s.box, "chmod 755 /usr/local/bin/opencode");

  struct CAgents *agents = NULL;
  assert(boxlite_box_agents(s.box, &agents, &error) == Ok);
  struct CAgentCreateOptions create = {.config_json =
                                           "{\"model\":\"fake/fake-model\"}"};
  assert(boxlite_agents_create(agents, "opencode", &create, on_agent, &s,
                               &error) == Ok);
  wait_ok(rt, &s);
  assert(s.agent);
  char *json = (char *)1;
  assert(boxlite_agent_state(s.agent, &json, &error) == Unsupported &&
         json == NULL);
  boxlite_error_free(&error);
  assert(boxlite_agent_config(s.agent, &json, &error) == Ok && json);
  printf("C_CONFIG=%s\n", json);
  boxlite_free_string(json);
  json = NULL;
  assert(boxlite_agent_capabilities(s.agent, &json, &error) == Ok && json);
  printf("C_CAPABILITIES=%s\n", json);
  boxlite_free_string(json);
  json = NULL;
  assert(boxlite_agent_events(s.agent, NULL, on_open, on_event, &s, &error) ==
         Ok);
  assert(!s.opened);
  drain_until(rt, &s.opened);
  assert(s.code == Ok && s.stream);
  assert(boxlite_agent_send(s.agent, "hello", NULL, on_turn, &s, &error) == Ok);
  wait_ok(rt, &s);
  assert(s.turn);
  assert(boxlite_agent_turn_state(s.turn, &json, &error) == Ok && json);
  printf("C_TURN=%s\n", json);
  boxlite_free_string(json);
  json = NULL;
  struct CAgentWaitOptions wait_options = {.timeout_seconds = 120};
  assert(boxlite_agent_turn_wait(s.turn, &wait_options, on_json, &s, &error) ==
         Ok);
  wait_ok(rt, &s);
  assert(s.result);
  drain_until(rt, &s.event_received);
  assert(s.first_event);
  printf("C_EVENT=%s\nC_RESULT=%s\n", s.first_event, s.result);
  free(s.result);
  s.result = NULL;
  assert(boxlite_agent_turn_steer(s.turn, "continue", NULL, on_json, &s,
                                  &error) == Ok);
  drain_until(rt, &s.done);
  assert(s.code == Unsupported && !s.result);
  assert(strstr(s.message, "OpenCode 2.2"));
  s.done = 0;
  boxlite_agent_turn_free(s.turn);
  s.turn = NULL;
  assert(boxlite_agent_send(s.agent, "SLOW", NULL, on_turn, &s, &error) == Ok);
  wait_ok(rt, &s);
  assert(s.turn);
  struct CAgentTurn *original_turn = s.turn;
  assert(boxlite_agent_turn_state(s.turn, &json, &error) == Ok && json);
  const char *id_start = strstr(json, "\"id\":\"");
  assert(id_start);
  id_start += strlen("\"id\":\"");
  const char *id_end = strchr(id_start, '"');
  assert(id_end && id_end > id_start && (size_t)(id_end - id_start) < 128);
  char turn_id[128];
  snprintf(turn_id, sizeof(turn_id), "%.*s", (int)(id_end - id_start),
           id_start);
  boxlite_free_string(json);
  json = NULL;
  /* Wait for the live stream to show this turn has started before freeing it.
   */
  int running = 0;
  for (int i = 0; i < 240 && !running; i++) {
    struct CAgentTurn *probe = NULL;
    s.turn = NULL;
    assert(boxlite_agent_get_turn(s.agent, turn_id, on_turn, &s, &error) == Ok);
    wait_ok(rt, &s);
    probe = s.turn;
    assert(boxlite_agent_turn_state(probe, &json, &error) == Ok && json);
    running = strstr(json, "\"status\":\"running\"") != NULL;
    boxlite_free_string(json);
    json = NULL;
    boxlite_agent_turn_free(probe);
  }
  assert(running);
  boxlite_agent_turn_free(original_turn);
  /* A fresh handle must observe completion after the original was released. */
  s.turn = NULL;
  assert(boxlite_agent_get_turn(s.agent, turn_id, on_turn, &s, &error) == Ok);
  wait_ok(rt, &s);
  assert(boxlite_agent_turn_wait(s.turn, &wait_options, on_json, &s, &error) ==
         Ok);
  wait_ok(rt, &s);
  assert(s.result && strstr(s.result, "\"status\":\"completed\""));
  free(s.result);
  s.result = NULL;
  boxlite_agent_events_free(s.stream);
  s.stream = NULL;
  drain_until(rt, &s.terminal);
  assert(s.terminal == 1 && s.terminal_error == Ok);
  boxlite_agent_turn_free(s.turn);
  boxlite_agent_free(s.agent);
  boxlite_agents_free(agents);
  assert(boxlite_stop_box(s.box, on_done, &s, &error) == Ok);
  wait_ok(rt, &s);
  boxlite_box_free(s.box);
  free(s.first_event);
  assert(boxlite_runtime_shutdown(rt, 30, on_done, &s, &error) == Ok);
  wait_ok(rt, &s);
  boxlite_runtime_free(rt);
  boxlite_error_free(&error);
  return 0;
}
