#include "boxlite.h"
#include <arpa/inet.h>
#include <assert.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

typedef struct GetRequest {
  int done;
  CBoxHandle *box;
  BoxliteErrorCode error_code;
} GetRequest;

static void write_all(int fd, const char *data) {
  size_t remaining = strlen(data);
  while (remaining > 0) {
    ssize_t written = write(fd, data, remaining);
    if (written <= 0) {
      _exit(10);
    }
    data += written;
    remaining -= (size_t)written;
  }
}

static pid_t start_box_server(uint16_t *port) {
  int listener = socket(AF_INET, SOCK_STREAM, 0);
  assert(listener >= 0);
  struct sockaddr_in address = {0};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(0x7f000001U);
  assert(bind(listener, (struct sockaddr *)&address, sizeof(address)) == 0);
  assert(listen(listener, 1) == 0);
  socklen_t address_len = sizeof(address);
  assert(getsockname(listener, (struct sockaddr *)&address, &address_len) == 0);
  *port = ntohs(address.sin_port);

  pid_t child = fork();
  assert(child >= 0);
  if (child == 0) {
    alarm(15);
    int client = accept(listener, NULL, NULL);
    if (client < 0) {
      _exit(11);
    }
    char request[4096] = {0};
    size_t used = 0;
    while (strstr(request, "\r\n\r\n") == NULL) {
      ssize_t count = read(client, request + used, sizeof(request) - used - 1);
      if (count <= 0) {
        _exit(12);
      }
      used += (size_t)count;
      if (used >= sizeof(request)) {
        _exit(12);
      }
      request[used] = '\0';
    }
    const char *expected = "GET /v1/boxes/agent-box HTTP/1.1\r\n";
    if (strncmp(request, expected, strlen(expected)) != 0) {
      _exit(13);
    }
    write_all(client,
              "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
              "Connection: close\r\n\r\n"
              "{\"box_id\":\"agent-box\",\"name\":null,\"status\":\"running\","
              "\"created_at\":\"2026-07-14T00:00:00Z\","
              "\"updated_at\":\"2026-07-14T00:00:00Z\",\"pid\":42,"
              "\"image\":\"alpine:latest\",\"cpus\":1,\"memory_mib\":512}");
    close(client);
    close(listener);
    _exit(0);
  }
  close(listener);
  return child;
}

static void on_get(CBoxHandle *box, CBoxliteError *error, void *data) {
  GetRequest *request = data;
  request->box = box;
  request->error_code = error->code;
  request->done = 1;
}

static void test_live_box_namespace(void) {
  uint16_t port = 0;
  pid_t server = start_box_server(&port);
  char base_url[64];
  int url_len =
      snprintf( // NOLINT(clang-analyzer-security.insecureAPI.DeprecatedOrUnsafeBufferHandling)
          base_url, sizeof(base_url), "http://127.0.0.1:%u", port);
  assert(url_len > 0 && (size_t)url_len < sizeof(base_url));

  CBoxliteError error = {0};
  CBoxliteRestOptions *options = NULL;
  assert(boxlite_rest_options_new(base_url, &options, &error) == Ok);
  CBoxliteRuntime *runtime = NULL;
  assert(boxlite_rest_runtime_new_with_options(options, &runtime, &error) ==
         Ok);
  boxlite_rest_options_free(options);

  GetRequest request = {0};
  assert(boxlite_get(runtime, "agent-box", on_get, &request, &error) == Ok);
  for (int attempt = 0; attempt < 20 && !request.done; attempt++) {
    assert(boxlite_runtime_drain(runtime, 500, &error) >= 0);
  }
  assert(request.done && request.error_code == Ok && request.box != NULL);

  struct CAgents *agents = NULL;
  assert(boxlite_box_agents(request.box, &agents, &error) == Ok);
  assert(agents != NULL);
  boxlite_agents_free(agents);
  boxlite_box_free(request.box);
  boxlite_runtime_free(runtime);
  boxlite_error_free(&error);

  int status = 0;
  assert(waitpid(server, &status, 0) == server);
  assert(WIFEXITED(status) && WEXITSTATUS(status) == 0);
}

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
  test_live_box_namespace();
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
