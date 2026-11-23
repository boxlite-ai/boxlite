/* Observe only the configured acceptance socket tuple. Never retain packets. */
#define _DEFAULT_SOURCE
#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <pcap/pcap.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t stopping;

static void stop(int signal_number) {
    (void)signal_number;
    stopping = 1;
}

static void fail(const char *message) {
    fprintf(stderr, "%s\n", message);
    exit(1);
}

static uint64_t now_ns(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_REALTIME, &now) != 0) fail("capture clock unavailable");
    return (uint64_t)now.tv_sec * 1000000000 + (uint64_t)now.tv_nsec;
}

static pcap_t *open_capture(const char *device, bool live) {
    char error[PCAP_ERRBUF_SIZE];
    if (!live) {
        pcap_t *capture = pcap_open_offline(device, error);
        if (!capture) fail(error);
        return capture;
    }
    pcap_t *capture = pcap_create(device, error);
    if (!capture) fail(error);
    if (pcap_set_snaplen(capture, 96) || pcap_set_timeout(capture, 100) ||
        pcap_set_immediate_mode(capture, 1) || pcap_activate(capture) != 0)
        fail(pcap_geterr(capture));
    if (pcap_setnonblock(capture, 1, error) != 0) fail(error);
    return capture;
}

static void restrict_capture(pcap_t *capture, const char *kind, const char *address, int port, const char *peer) {
    char filter[256];
    if (strcmp(kind, "syn") == 0) {
        snprintf(filter, sizeof(filter),
                 "ip and tcp and dst host %s and dst port %d and tcp[tcpflags] & (tcp-syn|tcp-ack) = tcp-syn",
                 address, port);
    } else if (strcmp(kind, "rst") == 0) {
        snprintf(filter, sizeof(filter),
                 "ip and tcp and src host %s and src port %d and dst host %s and tcp[tcpflags] & tcp-rst != 0",
                 address, port, peer);
    } else {
        snprintf(filter, sizeof(filter), "ip and udp and dst host %s and dst port %d", address, port);
    }
    struct bpf_program program;
    if (pcap_compile(capture, &program, filter, 1, PCAP_NETMASK_UNKNOWN) != 0) fail(pcap_geterr(capture));
    if (pcap_setfilter(capture, &program) != 0) fail(pcap_geterr(capture));
    pcap_freecode(&program);
}

int main(int argc, char **argv) {
    if (argc < 7 || argc > 8 || (strcmp(argv[1], "live") && strcmp(argv[1], "replay")))
        fail("usage: managed-outbound-capture live|replay INTERFACE_OR_PCAP syn|rst|udp IPV4 PORT LOG [PEER_IPV4]");
    bool live = strcmp(argv[1], "live") == 0;
    bool syn = strcmp(argv[3], "syn") == 0;
    bool rst = strcmp(argv[3], "rst") == 0;
    bool udp = strcmp(argv[3], "udp") == 0;
    struct in_addr parsed;
    if ((!syn && !rst && !udp) || argc != (rst ? 8 : 7) ||
        inet_pton(AF_INET, argv[4], &parsed) != 1 || (rst && inet_pton(AF_INET, argv[7], &parsed) != 1))
        fail("expected an IPv4 target and a peer IPv4 for RST capture");
    char *end;
    errno = 0;
    long port = strtol(argv[5], &end, 10);
    if (errno || end == argv[5] || *end || port < 1 || port > 65535) fail("invalid capture port");

    pcap_t *capture = open_capture(argv[2], live);
    restrict_capture(capture, argv[3], argv[4], (int)port, rst ? argv[7] : NULL);
    int fd = open(argv[6], O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR);
    if (fd < 0) fail("cannot create private capture log");
    FILE *log = fdopen(fd, "w");
    if (!log || setvbuf(log, NULL, _IOLBF, 0) != 0) fail("cannot stream capture log");
    struct sigaction action = {.sa_handler = stop};
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGINT, &action, NULL) || sigaction(SIGTERM, &action, NULL)) fail("cannot set capture signals");
    fprintf(log, "{\"event\":\"start\",\"kind\":\"%s\",\"address\":\"%s\",\"port\":%ld,"
                 "\"peer\":\"%s\",\"live\":%s,\"time_ns\":%" PRIu64 "}\n",
            argv[3], argv[4], port, rst ? argv[7] : "", live ? "true" : "false", now_ns());
    while (!stopping) {
        uint64_t covered_through = now_ns();
        struct pcap_pkthdr *header;
        const u_char *packet;
        int result = 0;
        while (!stopping && (result = pcap_next_ex(capture, &header, &packet)) == 1) {
            uint64_t observed = (uint64_t)header->ts.tv_sec * 1000000000 + (uint64_t)header->ts.tv_usec * 1000;
            fprintf(log, "{\"event\":\"packet\",\"time_ns\":%" PRIu64 "}\n", observed);
        }
        if (ferror(log)) fail("capture log write failed");
        if (stopping) break;
        if (result == PCAP_ERROR_BREAK && !live) break;
        if (result != 0) fail(pcap_geterr(capture));
        struct pcap_stat counters = {0};
        if (pcap_stats(capture, &counters) != 0) fail(pcap_geterr(capture));
        fprintf(log, "{\"event\":\"drained\",\"time_ns\":%" PRIu64 ",\"kernel_drops\":%u,\"interface_drops\":%u}\n",
                covered_through, counters.ps_drop, counters.ps_ifdrop);
        if (ferror(log)) fail("capture log write failed");
        const struct timespec pause = {.tv_nsec = 100000000};
        nanosleep(&pause, NULL);
    }
    pcap_close(capture);
    if (fclose(log) != 0) fail("capture log close failed");
    return 0;
}
