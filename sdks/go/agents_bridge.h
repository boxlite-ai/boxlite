#ifndef BOXLITE_GO_AGENTS_BRIDGE_H
#define BOXLITE_GO_AGENTS_BRIDGE_H
#include "boxlite.h"

/* Keep cgo tokens as integers in Go; only C converts them to opaque user_data. */
enum BoxliteErrorCode go_agent_create(struct CAgents *, const char *, const struct CAgentCreateOptions *, uintptr_t, CBoxliteError *);
enum BoxliteErrorCode go_agent_get(struct CAgents *, const char *, uintptr_t, CBoxliteError *);
enum BoxliteErrorCode go_agent_close(struct CAgent *, const struct CAgentControlOptions *, uintptr_t, CBoxliteError *);
enum BoxliteErrorCode go_agent_send(struct CAgent *, const char *, const struct CAgentSendOptions *, uintptr_t, CBoxliteError *);
enum BoxliteErrorCode go_agent_get_turn(struct CAgent *, const char *, uintptr_t, CBoxliteError *);
enum BoxliteErrorCode go_agent_requests(struct CAgent *, uintptr_t, CBoxliteError *);
enum BoxliteErrorCode go_agent_respond(struct CAgent *, const char *, const char *, const struct CAgentControlOptions *, uintptr_t, CBoxliteError *);
enum BoxliteErrorCode go_agent_wait(struct CAgentTurn *, const struct CAgentWaitOptions *, struct CAgentWait **, uintptr_t, CBoxliteError *);
enum BoxliteErrorCode go_agent_steer(struct CAgentTurn *, const char *, const struct CAgentControlOptions *, uintptr_t, CBoxliteError *);
enum BoxliteErrorCode go_agent_interrupt(struct CAgentTurn *, const struct CAgentControlOptions *, uintptr_t, CBoxliteError *);
enum BoxliteErrorCode go_agent_events(struct CAgent *, const struct CAgentEventsOptions *, uintptr_t, CBoxliteError *);
enum BoxliteErrorCode go_agent_turn_events(struct CAgentTurn *, const struct CAgentEventsOptions *, uintptr_t, CBoxliteError *);
void boxlite_go_drain_subscription(CBoxliteRuntime *, int);
size_t go_agent_event_length(const char *, size_t);
#endif
