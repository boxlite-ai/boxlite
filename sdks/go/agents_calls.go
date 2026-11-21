package boxlite

/*
#include "agents_bridge.h"
*/
import "C"

import (
	"context"
	"encoding/json"
	"runtime"
	"unicode/utf8"
)

func agentContextError(ctx context.Context) error {
	if ctx == nil {
		return agentJSONError(ErrInvalidArgument, "nil context")
	}
	return ctx.Err()
}
func agentFromResult(h *agentSession, err error) (*Agent, error) {
	if err != nil {
		return nil, err
	}
	return wrapAgent(h), nil
}
func turnFromResult(h *agentTurnHandle, err error) (*AgentTurn, error) {
	if err != nil {
		return nil, err
	}
	return wrapAgentTurn(h), nil
}
func agentJSONCall[T any, P comparable](ctx context.Context, h *agentHandle[P], submit func(P, C.uintptr_t, *C.CBoxliteError) C.enum_BoxliteErrorCode, parse func([]byte) (T, error)) (T, error) {
	data, err := agentCall[[]byte](ctx, h, submit, nil)
	if err != nil {
		var zero T
		return zero, err
	}
	return parse(data)
}

func (a *Agents) Create(ctx context.Context, agent string, options AgentCreateOptions) (*Agent, error) {
	defer runtime.KeepAlive(a)
	if err := agentContextError(ctx); err != nil {
		return nil, err
	}
	config, err := agentConfigJSON(options.Config)
	if err != nil {
		return nil, err
	}
	var args agentArguments
	defer args.free()
	name := args.string(agent, "agent", false)
	opts := C.struct_CAgentCreateOptions{cwd: args.string(options.Cwd, "cwd", true), config_json: args.string(string(config), "config", false), idempotency_key: args.string(options.IdempotencyKey, "idempotency_key", true)}
	if args.err != nil {
		return nil, args.err
	}
	h, err := a.namespace()
	if err != nil {
		return nil, err
	}
	return agentFromResult(agentCall[*agentSession](ctx, h, func(p *C.struct_CAgents, token C.uintptr_t, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.go_agent_create(p, name, &opts, token, e)
	}, func(h *agentSession) { h.release() }))
}

func (a *Agents) Get(ctx context.Context, agentID string) (*Agent, error) {
	defer runtime.KeepAlive(a)
	if err := agentContextError(ctx); err != nil {
		return nil, err
	}
	var args agentArguments
	defer args.free()
	id := args.string(agentID, "agent_id", false)
	if args.err != nil {
		return nil, args.err
	}
	h, err := a.namespace()
	if err != nil {
		return nil, err
	}
	return agentFromResult(agentCall[*agentSession](ctx, h, func(p *C.struct_CAgents, token C.uintptr_t, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.go_agent_get(p, id, token, e)
	}, func(h *agentSession) { h.release() }))
}

func (s *Agent) Close(ctx context.Context, options AgentControlOptions) error {
	defer runtime.KeepAlive(s)
	var args agentArguments
	defer args.free()
	opts := args.control(options)
	if args.err != nil {
		return args.err
	}
	_, err := agentCall[[]byte](ctx, agentSessionOf(s), func(p *C.struct_CAgent, token C.uintptr_t, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.go_agent_close(p, &opts, token, e)
	}, nil)
	return err
}

func (s *Agent) Send(ctx context.Context, text string, options AgentSendOptions) (*AgentTurn, error) {
	defer runtime.KeepAlive(s)
	var mode C.int32_t
	switch options.Mode {
	case "", AgentSendQueue:
	case AgentSendReject:
		mode = 1
	default:
		return nil, agentJSONError(ErrInvalidArgument, "invalid send mode")
	}
	if len(options.Data) > 0 && (!utf8.Valid(options.Data) || !json.Valid(options.Data)) {
		return nil, agentJSONError(ErrInvalidArgument, "invalid send data JSON")
	}
	var args agentArguments
	defer args.free()
	input := args.string(text, "text", false)
	opts := C.struct_CAgentSendOptions{mode: mode, data_json: args.string(string(agentRaw(options.Data)), "data", true), idempotency_key: args.string(options.IdempotencyKey, "idempotency_key", true)}
	if args.err != nil {
		return nil, args.err
	}
	return turnFromResult(agentCall[*agentTurnHandle](ctx, agentSessionOf(s), func(p *C.struct_CAgent, token C.uintptr_t, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.go_agent_send(p, input, &opts, token, e)
	}, func(h *agentTurnHandle) { h.release() }))
}

func (s *Agent) GetTurn(ctx context.Context, turnID string) (*AgentTurn, error) {
	defer runtime.KeepAlive(s)
	var args agentArguments
	defer args.free()
	id := args.string(turnID, "turn_id", false)
	if args.err != nil {
		return nil, args.err
	}
	return turnFromResult(agentCall[*agentTurnHandle](ctx, agentSessionOf(s), func(p *C.struct_CAgent, token C.uintptr_t, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.go_agent_get_turn(p, id, token, e)
	}, func(h *agentTurnHandle) { h.release() }))
}

func (s *Agent) Requests(ctx context.Context) ([]AgentRequest, error) {
	defer runtime.KeepAlive(s)
	return agentJSONCall(ctx, agentSessionOf(s), func(p *C.struct_CAgent, token C.uintptr_t, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.go_agent_requests(p, token, e)
	}, parseAgentRequests)
}

func (s *Agent) Respond(ctx context.Context, requestID string, response AgentResponse, options AgentControlOptions) (*AgentTurn, error) {
	defer runtime.KeepAlive(s)
	encoded, err := agentResponseJSON(response)
	if err != nil {
		return nil, err
	}
	var args agentArguments
	defer args.free()
	id := args.string(requestID, "request_id", false)
	input := args.string(string(encoded), "response", false)
	opts := args.control(options)
	if args.err != nil {
		return nil, args.err
	}
	return turnFromResult(agentCall[*agentTurnHandle](ctx, agentSessionOf(s), func(p *C.struct_CAgent, token C.uintptr_t, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.go_agent_respond(p, id, input, &opts, token, e)
	}, func(h *agentTurnHandle) { h.release() }))
}

func (s *Agent) State() (*AgentState, error) {
	defer runtime.KeepAlive(s)
	return agentGetter(agentSessionOf(s), func(p *C.struct_CAgent, j **C.char, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_agent_state(p, j, e)
	}, parseAgentState)
}
func (s *Agent) Config() (*AgentConfig, error) {
	defer runtime.KeepAlive(s)
	return agentGetter(agentSessionOf(s), func(p *C.struct_CAgent, j **C.char, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_agent_config(p, j, e)
	}, parseAgentConfig)
}
func (s *Agent) Capabilities() (*AgentCapabilities, error) {
	defer runtime.KeepAlive(s)
	return agentGetter(agentSessionOf(s), func(p *C.struct_CAgent, j **C.char, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_agent_capabilities(p, j, e)
	}, parseAgentCapabilities)
}
func (t *AgentTurn) State() (*AgentTurnState, error) {
	defer runtime.KeepAlive(t)
	return agentGetter(agentTurnOf(t), func(p *C.struct_CAgentTurn, j **C.char, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_agent_turn_state(p, j, e)
	}, parseAgentTurnState)
}

func (t *AgentTurn) Wait(ctx context.Context, options AgentWaitOptions) (*AgentResult, error) {
	defer runtime.KeepAlive(t)
	opts := C.struct_CAgentWaitOptions{timeout_seconds: -1}
	if options.Timeout != nil && *options.Timeout >= 0 {
		opts.timeout_seconds = C.double(options.Timeout.Seconds())
	}
	return agentJSONCall(ctx, agentTurnOf(t), func(p *C.struct_CAgentTurn, token C.uintptr_t, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.go_agent_wait(p, &opts, token, e)
	}, parseAgentResult)
}
func (t *AgentTurn) Steer(ctx context.Context, text string, options AgentControlOptions) (*AgentSteeringReceipt, error) {
	defer runtime.KeepAlive(t)
	var args agentArguments
	defer args.free()
	input := args.string(text, "text", false)
	opts := args.control(options)
	if args.err != nil {
		return nil, args.err
	}
	return agentJSONCall(ctx, agentTurnOf(t), func(p *C.struct_CAgentTurn, token C.uintptr_t, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.go_agent_steer(p, input, &opts, token, e)
	}, parseAgentReceipt)
}
func (t *AgentTurn) Interrupt(ctx context.Context, options AgentControlOptions) error {
	defer runtime.KeepAlive(t)
	var args agentArguments
	defer args.free()
	opts := args.control(options)
	if args.err != nil {
		return args.err
	}
	_, err := agentCall[[]byte](ctx, agentTurnOf(t), func(p *C.struct_CAgentTurn, token C.uintptr_t, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.go_agent_interrupt(p, &opts, token, e)
	}, nil)
	return err
}
