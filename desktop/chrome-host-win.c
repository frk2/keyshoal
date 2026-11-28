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

static BOOL check_acl(HANDLE handle, PSID sid, BOOL directory) {
    PSECURITY_DESCRIPTOR descriptor = NULL;
    PSID owner = NULL;
    PACL acl = NULL;
    BOOL accepted = FALSE, has_user = FALSE;
    if (GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &owner, NULL, &acl, NULL, &descriptor) != ERROR_SUCCESS || !owner || !acl) goto done;
    if (!EqualSid(owner, sid) && (directory ||
            (!IsWellKnownSid(owner, WinBuiltinAdministratorsSid) && !IsWellKnownSid(owner, WinLocalSystemSid)))) goto done;

    SECURITY_DESCRIPTOR_CONTROL control;
    DWORD revision = 0;
    if (!GetSecurityDescriptorControl(descriptor, &control, &revision) ||
        (directory && !(control & SE_DACL_PROTECTED))) goto done;

    ACL_SIZE_INFORMATION info;
    if (!GetAclInformation(acl, &info, (DWORD)sizeof info, AclSizeInformation)) goto done;
    for (DWORD i = 0; i < info.AceCount; ++i) {
        void *entry = NULL;
        if (!GetAce(acl, i, &entry)) goto done;
        ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE *)entry;
        if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE) goto done;
        PSID trustee = &ace->SidStart;
        if (EqualSid(trustee, sid)) {
            BOOL children = (ace->Header.AceFlags & (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)) ==
                (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE);
            if (!(ace->Header.AceFlags & INHERIT_ONLY_ACE) && (!directory || children) &&
                (((ace->Mask & FILE_ALL_ACCESS) == FILE_ALL_ACCESS) || (ace->Mask & GENERIC_ALL))) has_user = TRUE;
        } else if (!IsWellKnownSid(trustee, WinLocalSystemSid)) goto done;
    }
    accepted = has_user;
done:
    if (descriptor) LocalFree(descriptor);
    return accepted;
}

static int private_path(const wchar_t *path, PSID sid, BOOL directory) {
    if (directory) {
        PSECURITY_DESCRIPTOR desired = NULL;
        if (!make_security(sid, TRUE, &desired)) return 1;
        SECURITY_ATTRIBUTES sa = { sizeof sa, desired, FALSE };
        BOOL exists = CreateDirectoryW(path, &sa) || GetLastError() == ERROR_ALREADY_EXISTS;
        LocalFree(desired);
        if (!exists) return 1;
    }
    HANDLE handle = CreateFileW(path, READ_CONTROL | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), NULL);
    if (handle == INVALID_HANDLE_VALUE) return 1;
    BY_HANDLE_FILE_INFORMATION info;
    BOOL ok = GetFileInformationByHandle(handle, &info) &&
        !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
        (!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == !directory) &&
        check_acl(handle, sid, directory);
    CloseHandle(handle);
    return !ok;
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
        return private_path(argv[2], sid.bytes, TRUE);
    }
    if (argc == 3 && wcscmp(argv[1], L"--check-vault") == 0) {
        return private_path(argv[2], sid.bytes, FALSE);
    }
    wchar_t name[256];
    DWORD session = 0;
    if (!pipe_name(sid.bytes, name, _countof(name), &session)) return 1;
    if (argc == 3 && wcscmp(argv[1], L"--broker") == 0) return broker(name, sid.bytes, session, argv[2]);
    if (!extension_origin(argv[1])) return 1;
    return relay(name, sid.bytes, session);
}
