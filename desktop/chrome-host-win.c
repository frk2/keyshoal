/* Windows local Chrome relay and per-user pipe broker. No vault parsing here. */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <stdint.h>
#include <stddef.h>
#include <wchar.h>
#include <stdlib.h>
#include <string.h>

#define REQ_MAX 4096u
#define REPLY_MAX (512u * 1024u)
#define IO_TIMEOUT 3500u

typedef union {
    SID alignment;
    BYTE bytes[SECURITY_MAX_SID_SIZE];
} SidBuffer;

static BOOL user_sid(HANDLE process, SidBuffer *sid) {
    HANDLE token = NULL;
    union { TOKEN_USER user; BYTE bytes[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE]; } storage;
    DWORD used = 0;
    if (!OpenProcessToken(process, TOKEN_QUERY, &token)) return FALSE;
    BOOL ok = GetTokenInformation(token, TokenUser, storage.bytes, (DWORD)sizeof storage.bytes, &used) &&
        CopySid((DWORD)sizeof sid->bytes, sid->bytes, storage.user.User.Sid);
    CloseHandle(token);
    return ok;
}

static BOOL make_security(PSID sid, BOOL directory, PSECURITY_DESCRIPTOR *descriptor) {
    wchar_t *text = NULL;
    wchar_t sddl[512];
    if (!ConvertSidToStringSidW(sid, &text)) return FALSE;
    int n = swprintf_s(sddl, _countof(sddl), directory ?
        L"O:%lsD:P(A;OICI;FA;;;%ls)(A;OICI;FA;;;SY)" : L"O:%lsD:P(A;;GA;;;%ls)", text, text);
    LocalFree(text);
    return n > 0 && ConvertStringSecurityDescriptorToSecurityDescriptorW(
        sddl, SDDL_REVISION_1, descriptor, NULL);
}

static int private_directory(const wchar_t *dir, PSID sid) {
    int result = 1;
    PSECURITY_DESCRIPTOR desired = NULL, current = NULL;
    if (!make_security(sid, TRUE, &desired)) return 1;
    SECURITY_ATTRIBUTES sa = { sizeof sa, desired, FALSE };
    if (!CreateDirectoryW(dir, &sa) && GetLastError() != ERROR_ALREADY_EXISTS) {
        LocalFree(desired);
        return 1;
    }
    HANDLE handle = CreateFileW(dir, READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, NULL);
    if (handle != INVALID_HANDLE_VALUE) {
        BY_HANDLE_FILE_INFORMATION info;
        PSID owner = NULL;
        BOOL present = FALSE, defaulted = FALSE;
        PACL dacl = NULL;
        if (GetFileInformationByHandle(handle, &info) &&
            (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) &&
            !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
            GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
                &owner, NULL, NULL, NULL, &current) == ERROR_SUCCESS &&
            owner && EqualSid(owner, sid) &&
            GetSecurityDescriptorDacl(desired, &present, &dacl, &defaulted) &&
            present && dacl &&
            SetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                            NULL, NULL, dacl, NULL) == ERROR_SUCCESS) result = 0;
        CloseHandle(handle);
    }
    if (current) LocalFree(current);
    LocalFree(desired);
    return result;
}

static BOOL pipe_name(PSID sid, wchar_t *name, size_t count, DWORD *session) {
    wchar_t *text = NULL;
    if (!ProcessIdToSessionId(GetCurrentProcessId(), session) || !ConvertSidToStringSidW(sid, &text)) return FALSE;
    int n = swprintf_s(name, count, L"\\\\.\\pipe\\Keyshoal-%ls-%lu", text, (unsigned long)*session);
    LocalFree(text);
    return n > 0;
}

static BOOL wait_io(HANDLE handle, OVERLAPPED *op, DWORD *moved) {
    if (WaitForSingleObject(op->hEvent, IO_TIMEOUT) == WAIT_OBJECT_0) {
        return GetOverlappedResult(handle, op, moved, FALSE);
    }
    CancelIoEx(handle, op);
    GetOverlappedResult(handle, op, moved, TRUE);
    return FALSE;
}

static BOOL full(HANDLE handle, void *buffer, DWORD size, BOOL writing, BOOL overlapped) {
    BYTE *at = (BYTE *)buffer;
    while (size > 0) {
        DWORD moved = 0;
        OVERLAPPED op = {0};
        if (overlapped) {
            op.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
            if (!op.hEvent) return FALSE;
        }
        DWORD *immediate = overlapped ? NULL : &moved;
        BOOL ok = writing ? WriteFile(handle, at, size, immediate, overlapped ? &op : NULL) :
            ReadFile(handle, at, size, immediate, overlapped ? &op : NULL);
        if (overlapped) {
            if (ok) ok = GetOverlappedResult(handle, &op, &moved, FALSE);
            else if (GetLastError() == ERROR_IO_PENDING) ok = wait_io(handle, &op, &moved);
            CloseHandle(op.hEvent);
        }
        if (!ok || !moved || moved > size) return FALSE;
        size -= moved;
        at += moved;
    }
    return TRUE;
}

static BOOL accept_one(HANDLE pipe) {
    OVERLAPPED op = {0};
    op.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!op.hEvent) return FALSE;
    BOOL ok = ConnectNamedPipe(pipe, &op);
    if (!ok) {
        DWORD code = GetLastError();
        if (code == ERROR_PIPE_CONNECTED) ok = TRUE;
        else if (code == ERROR_IO_PENDING) {
            DWORD ignored;
            // The parent monitor terminates the broker when the desktop exits.
            ok = GetOverlappedResult(pipe, &op, &ignored, TRUE);
        }
    }
    CloseHandle(op.hEvent);
    return ok;
}

static DWORD WINAPI watch_parent(LPVOID parent) {
    WaitForSingleObject(parent, INFINITE);
    ExitProcess(1);
}

static DWORD WINAPI relay_timeout(LPVOID unused) {
    (void)unused;
    Sleep(9000);
    ExitProcess(1);
}

static BOOL start_watcher(LPTHREAD_START_ROUTINE callback, void *arg) {
    HANDLE thread = CreateThread(NULL, 0, callback, arg, 0, NULL);
    if (!thread) return FALSE;
    CloseHandle(thread);
    return TRUE;
}

static int broker(const wchar_t *name, PSID sid, DWORD session, const wchar_t *parent_text) {
    wchar_t *end = NULL;
    unsigned long parent_id = wcstoul(parent_text, &end, 10);
    if (!parent_id || !end || *end || parent_id == GetCurrentProcessId()) return 1;
    HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, (DWORD)parent_id);
    if (!parent) return 1;
    if (!start_watcher(watch_parent, parent)) { CloseHandle(parent); return 1; }

    PSECURITY_DESCRIPTOR descriptor = NULL;
    if (!make_security(sid, FALSE, &descriptor)) return 1;
    SECURITY_ATTRIBUTES sa = { sizeof sa, descriptor, FALSE };
    HANDLE pipe = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1,
        REPLY_MAX + 4, REQ_MAX + 4, IO_TIMEOUT, &sa);
    LocalFree(descriptor);
    if (pipe == INVALID_HANDLE_VALUE) return 1;
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    BYTE ready = 'R';
    BYTE request[REQ_MAX];
    BYTE *reply = (BYTE *)malloc(REPLY_MAX);
    if (!reply || !full(output, &ready, 1, TRUE, FALSE)) {
        free(reply);
        CloseHandle(pipe);
        return 1;
    }
    while (accept_one(pipe)) {
        ULONG client_session = 0;
        DWORD count = 0;
        if (GetNamedPipeClientSessionId(pipe, &client_session) && client_session == session &&
            full(pipe, &count, 4, FALSE, TRUE) && count >= 2 && count <= REQ_MAX &&
            full(pipe, request, count, FALSE, TRUE)) {
            if (!full(output, &count, 4, TRUE, FALSE) || !full(output, request, count, TRUE, FALSE) ||
                !full(input, &count, 4, FALSE, FALSE) || count < 2 || count > REPLY_MAX ||
                !full(input, reply, count, FALSE, FALSE)) break;
            if (full(pipe, &count, 4, TRUE, TRUE) && full(pipe, reply, count, TRUE, TRUE)) {
                BYTE acknowledgement = 0;
                // Wait until the relay has consumed both writes before disconnecting.
                full(pipe, &acknowledgement, 1, FALSE, TRUE);
            }
            SecureZeroMemory(reply, count);
        }
        SecureZeroMemory(request, sizeof request);
        DisconnectNamedPipe(pipe);
    }
    SecureZeroMemory(reply, REPLY_MAX);
    free(reply);
    CloseHandle(pipe);
    return 1;
}

static BOOL expected_broker(HANDLE pipe, PSID sid, DWORD session) {
    ULONG server = 0, server_session = 0;
    if (!GetNamedPipeServerProcessId(pipe, &server) ||
        !GetNamedPipeServerSessionId(pipe, &server_session) || server_session != session) return FALSE;
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, server);
    if (!process) return FALSE;
    SidBuffer identity;
    BOOL ok = user_sid(process, &identity) && EqualSid(identity.bytes, sid);
    CloseHandle(process);
    return ok;
}

static int unavailable(HANDLE output) {
    char message[] = "{\"error\":\"Open the Keyshoal desktop app and check that its Chrome bridge is running.\"}";
    DWORD count = (DWORD)(sizeof message - 1);
    return !(full(output, &count, 4, TRUE, FALSE) && full(output, message, count, TRUE, FALSE));
}

static int relay(const wchar_t *name, PSID sid, DWORD session) {
    if (!start_watcher(relay_timeout, NULL)) return 1;
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    DWORD count = 0;
    BYTE request[REQ_MAX];
    if (!full(input, &count, 4, FALSE, FALSE) || count < 2 || count > REQ_MAX ||
        !full(input, request, count, FALSE, FALSE)) return 1;
    if (!WaitNamedPipeW(name, IO_TIMEOUT)) return unavailable(output);
    HANDLE pipe = CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING,
        FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, NULL);
    if (pipe == INVALID_HANDLE_VALUE) return unavailable(output);
    BOOL ok = expected_broker(pipe, sid, session) && full(pipe, &count, 4, TRUE, TRUE) &&
        full(pipe, request, count, TRUE, TRUE) && full(pipe, &count, 4, FALSE, TRUE) &&
        count >= 2 && count <= REPLY_MAX;
    SecureZeroMemory(request, sizeof request);
    if (!ok) { CloseHandle(pipe); return unavailable(output); }
    BYTE *reply = (BYTE *)malloc(count);
    if (!reply || !full(pipe, reply, count, FALSE, TRUE)) {
        free(reply);
        CloseHandle(pipe);
        return unavailable(output);
    }
    BYTE acknowledgement = 1;
    full(pipe, &acknowledgement, 1, TRUE, TRUE);
    CloseHandle(pipe);
    ok = full(output, &count, 4, TRUE, FALSE) && full(output, reply, count, TRUE, FALSE);
    SecureZeroMemory(reply, count);
    free(reply);
    return !ok;
}

static BOOL extension_origin(const wchar_t *origin) {
    const wchar_t prefix[] = L"chrome-extension://";
    const size_t length = _countof(prefix) - 1;
    if (wcsncmp(origin, prefix, length) != 0) return FALSE;
    origin += length;
    if (wcslen(origin) != 33 || origin[32] != L'/') return FALSE;
    for (size_t i = 0; i < 32; ++i) if (origin[i] < L'a' || origin[i] > L'p') return FALSE;
    return TRUE;
}

int wmain(int argc, wchar_t **argv) {
    if (argc < 2) return 1;
    SidBuffer sid;
    if (!user_sid(GetCurrentProcess(), &sid)) return 1;
    if (argc == 3 && wcscmp(argv[1], L"--private-directory") == 0) {
        return private_directory(argv[2], sid.bytes);
    }
    wchar_t name[256];
    DWORD session = 0;
    if (!pipe_name(sid.bytes, name, _countof(name), &session)) return 1;
    if (argc == 3 && wcscmp(argv[1], L"--broker") == 0) return broker(name, sid.bytes, session, argv[2]);
    if (!extension_origin(argv[1])) return 1;
    return relay(name, sid.bytes, session);
}
