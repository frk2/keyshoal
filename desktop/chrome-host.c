/* Chrome Native Messaging relay. Never interprets or logs credentials. */
#include <errno.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

static int io_full(int fd, void *buffer, size_t left, int writing) {
    unsigned char *at = buffer;
    while (left) {
        ssize_t count = writing ? write(fd, at, left) : read(fd, at, left);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return 0;
        at += count;
        left -= (size_t)count;
    }
    return 1;
}

static int fail(void) {
    char msg[] = "{\"error\":\"Open the Keyshoal desktop app and check that its Chrome bridge is running.\"}";
    uint32_t n = (uint32_t)(sizeof msg - 1);
    return !(io_full(STDOUT_FILENO, &n, sizeof n, 1) && io_full(STDOUT_FILENO, msg, n, 1));
}

int main(int argc, char **argv) {
    signal(SIGPIPE, SIG_IGN);
    alarm(6);
    const char *prefix = "chrome-extension://";
    if (argc < 2 || strncmp(argv[1], prefix, strlen(prefix)) != 0) return 1;
    const char *id = argv[1] + strlen(prefix);
    if (strlen(id) != 33 || strspn(id, "abcdefghijklmnop") != 32 || id[32] != '/') return 1;
    uint32_t n = 0;
    unsigned char request[4096];
    if (!io_full(STDIN_FILENO, &n, sizeof n, 0) || n < 2 || n > sizeof request ||
        !io_full(STDIN_FILENO, request, n, 0)) return 1;
    const char *runtime = getenv("XDG_RUNTIME_DIR");
    if (!runtime || runtime[0] != '/') return fail();
    struct sockaddr_un addr = { .sun_family = AF_UNIX };
    int size = snprintf(addr.sun_path, sizeof addr.sun_path, "%s/keyshoal/host.sock", runtime);
    if (size < 0 || (size_t)size >= sizeof addr.sun_path) return fail();
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) return fail();
    struct timeval timeout = { .tv_sec = 3 };
    if (setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout) ||
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof timeout) ||
        connect(fd, (const struct sockaddr *)&addr, sizeof addr) ||
        !io_full(fd, &n, sizeof n, 1) || !io_full(fd, request, n, 1) ||
        !io_full(fd, &n, sizeof n, 0) || n < 2 || n > 512 * 1024) {
        close(fd);
        return fail();
    }
    unsigned char *response = malloc(n);
    if (!response || !io_full(fd, response, n, 0)) {
        close(fd);
        free(response);
        return fail();
    }
    close(fd);
    int ok = io_full(STDOUT_FILENO, &n, sizeof n, 1) && io_full(STDOUT_FILENO, response, n, 1);
    free(response);
    return !ok;
}
