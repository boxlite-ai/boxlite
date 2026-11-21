#include "agents_bridge.h"

extern void goBoxliteAgentCreated(struct CAgent *, CBoxliteError *, uintptr_t);
extern void goBoxliteAgentTurn(struct CAgentTurn *, CBoxliteError *, uintptr_t);
extern void goBoxliteAgentJSON(char *, CBoxliteError *, uintptr_t);

static void agent_created(struct CAgent *agent, const CBoxliteError *error, void *data) {
    goBoxliteAgentCreated(agent, (CBoxliteError *)error, (uintptr_t)data);
}
static void agent_turn(struct CAgentTurn *turn, const CBoxliteError *error, void *data) {
    goBoxliteAgentTurn(turn, (CBoxliteError *)error, (uintptr_t)data);
}
static void agent_json(const char *json, const CBoxliteError *error, void *data) {
    goBoxliteAgentJSON((char *)json, (CBoxliteError *)error, (uintptr_t)data);
}
static void agent_done(const CBoxliteError *error, void *data) {
    goBoxliteAgentJSON(NULL, (CBoxliteError *)error, (uintptr_t)data);
}
enum BoxliteErrorCode go_agent_create(struct CAgents *agents, const char *name, const struct CAgentCreateOptions *options, uintptr_t token, CBoxliteError *error) {
    return boxlite_agents_create(agents, name, options, agent_created, (void *)token, error);
}
enum BoxliteErrorCode go_agent_get(struct CAgents *agents, const char *id, uintptr_t token, CBoxliteError *error) {
    return boxlite_agents_get(agents, id, agent_created, (void *)token, error);
}
enum BoxliteErrorCode go_agent_close(struct CAgent *agent, const struct CAgentControlOptions *options, uintptr_t token, CBoxliteError *error) {
    return boxlite_agent_close(agent, options, agent_done, (void *)token, error);
}
enum BoxliteErrorCode go_agent_send(struct CAgent *agent, const char *text, const struct CAgentSendOptions *options, uintptr_t token, CBoxliteError *error) {
    return boxlite_agent_send(agent, text, options, agent_turn, (void *)token, error);
}
enum BoxliteErrorCode go_agent_get_turn(struct CAgent *agent, const char *id, uintptr_t token, CBoxliteError *error) {
    return boxlite_agent_get_turn(agent, id, agent_turn, (void *)token, error);
}
enum BoxliteErrorCode go_agent_requests(struct CAgent *agent, uintptr_t token, CBoxliteError *error) {
    return boxlite_agent_requests(agent, agent_json, (void *)token, error);
}
enum BoxliteErrorCode go_agent_respond(struct CAgent *agent, const char *id, const char *response, const struct CAgentControlOptions *options, uintptr_t token, CBoxliteError *error) {
    return boxlite_agent_respond(agent, id, response, options, agent_turn, (void *)token, error);
}
enum BoxliteErrorCode go_agent_wait(struct CAgentTurn *turn, const struct CAgentWaitOptions *options, uintptr_t token, CBoxliteError *error) {
    return boxlite_agent_turn_wait(turn, options, agent_json, (void *)token, error);
}
enum BoxliteErrorCode go_agent_steer(struct CAgentTurn *turn, const char *text, const struct CAgentControlOptions *options, uintptr_t token, CBoxliteError *error) {
    return boxlite_agent_turn_steer(turn, text, options, agent_json, (void *)token, error);
}
enum BoxliteErrorCode go_agent_interrupt(struct CAgentTurn *turn, const struct CAgentControlOptions *options, uintptr_t token, CBoxliteError *error) {
    return boxlite_agent_turn_interrupt(turn, options, agent_done, (void *)token, error);
}
