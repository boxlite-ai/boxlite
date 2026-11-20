/* SPDX-License-Identifier: BSD-2-Clause OR GPL-2.0-only */
/* Copyright (c) BoxLite contributors. */
/* Per-cgroup deadline enforced before socket and IP packet admission. */
typedef unsigned long long u64;
typedef unsigned int u32;

#define SEC(name) __attribute__((section(name), used))
#define BPF_ARRAY(value_type)                                                  \
	struct {                                                               \
		int (*type)[2];                                                \
		int (*max_entries)[1];                                         \
		u32 *key;                                                      \
		value_type *value;                                             \
	}
#define CORE __attribute__((preserve_access_index))
#define INLINE static inline __attribute__((always_inline))

enum socket_family { unix_socket = 1, ipv4_socket = 2, ipv6_socket = 10 };

struct sock_common {
	unsigned short skc_family;
	struct {
		long long counter;
	} skc_cookie;
} CORE;

struct sock {
	struct sock_common __sk_common;
} CORE;

struct socket {
	struct sock *sk;
} CORE;

static void *(*const lookup)(const void *, const u32 *) = (void *)1;
static u64 (*const monotonic_ns)(void) = (void *)5;
static long (*const skb_load_bytes)(void *, u32, void *, u32) = (void *)26;

BPF_ARRAY(u64) cloud_deadline SEC(".maps");
BPF_ARRAY(u64) cloud_guest SEC(".maps");

INLINE int deadline_active(void)
{
	const u32 zero = 0;
	u64 *deadline = lookup(&cloud_deadline, &zero);
	if (!deadline)
		return 0;

	u64 prior = *(volatile u64 *)deadline;
	if (prior && monotonic_ns() < prior)
		return 1;
	if (prior)
		__sync_val_compare_and_swap(deadline, prior, 0);
	return 0;
}

INLINE int internet_family(unsigned short family)
{
	return family == ipv4_socket || family == ipv6_socket;
}

SEC("lsm_cgroup/socket_connect")
int cloud_connect(const u64 *args)
{
	const struct socket *socket = (const void *)args[0];
	const struct sock *sock = socket->sk;
	if (!sock)
		return 0;
	return !internet_family(sock->__sk_common.skc_family) || deadline_active();
}

SEC("lsm_cgroup/socket_sendmsg")
int cloud_send(const u64 *args)
{
	const struct socket *socket = (const void *)args[0];
	const struct sock *sock = socket->sk;
	if (!sock)
		return 0;
	unsigned short family = sock->__sk_common.skc_family;
	if (internet_family(family))
		return deadline_active();
	if (family != unix_socket)
		return 1;
	const u32 zero = 0;
	const volatile u64 *registered = lookup(&cloud_guest, &zero);
	if (!registered)
		return 0;
	u64 cookie = *registered;
	if (!cookie || (u64)sock->__sk_common.skc_cookie.counter != cookie)
		return 1;
	return deadline_active();
}

SEC("cgroup_skb/egress")
int cloud_egress(void *skb)
{
	(void)skb;
	return deadline_active();
}

struct renewal {
	u64 prior;
	u64 next;
};

/* Only the host calls this pinned program with a synthetic packet. */
SEC("socket")
int cloud_renew(void *skb)
{
	const u32 zero = 0;
	u64 *deadline = lookup(&cloud_deadline, &zero);
	struct renewal request;

	if (!deadline || skb_load_bytes(skb, 0, &request, sizeof(request)) || !request.prior)
		return 0;

	u64 now = monotonic_ns();
	if (now >= request.prior || now >= request.next)
		return 0;

	return __sync_val_compare_and_swap(deadline, request.prior, request.next) == request.prior;
}

char bpf_license[] SEC("license") = "Dual BSD/GPL";
