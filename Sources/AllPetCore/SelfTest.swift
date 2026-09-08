import Foundation
#if canImport(AppKit)
import AppKit
#endif
#if canImport(ImageIO)
import ImageIO
#endif

public struct AllPetSelfTestReport: Sendable {
    public var checks: Int
    public var failures: [String]

    public var passed: Bool { failures.isEmpty }
}

/// 无需 XCTest 的内建解析器检查；适配仅安装 Command Line Tools 的 macOS。
#if os(macOS)
public enum AllPetSelfTest {
    public static func run() -> AllPetSelfTestReport {
        var checks = 0
        var failures: [String] = []

        func expect(_ condition: @autoclosure () -> Bool, _ name: String) {
            checks += 1
            if !condition() { failures.append(name) }
        }

        let codex = TaskExtractors.codex(from: """
        {"type":"event_msg","payload":{"type":"task_started"}}
        {"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"修复一键启动"}]}}
        {"type":"response_item","payload":{"type":"custom_tool_call","name":"exec_command","arguments":{"description":"构建 AllPet"}}}
        """)
        expect(codex.phase == .running, "Codex phase")
        expect(codex.info.title == "修复一键启动", "Codex task title")
        expect(codex.info.action == "运行命令：构建 AllPet", "Codex tool action")

        let codexIdentity = TaskExtractors.codex(from: #"{"type":"session_meta","payload":{"id":"codex-session","cwd":"/tmp/codex"}}"#)
        expect(codexIdentity.sessionID == "codex-session" && codexIdentity.workingDirectory == "/tmp/codex", "Codex launch identity")

        let codexAmbient = TaskExtractors.codex(from: """
        {"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"真实任务"}]}}
        {"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<in-app-browser-context>ambient state</in-app-browser-context>"}]}}
        """)
        expect(codexAmbient.info.title == "真实任务", "Codex ambient prompt filter")

        let codexFailure = TaskExtractors.codex(from: #"{"type":"event_msg","payload":{"type":"task_complete","error":{"message":"{\"error\":{\"message\":\"模型不可用\"}}"}}}"#)
        expect(codexFailure.info.action == "失败：模型不可用", "Codex nested error message")

        let claude = TaskExtractors.claude(from: """
        {"type":"user","origin":{"kind":"human"},"message":{"role":"user","content":"检查当前项目"}}
        {"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"description":"运行测试"}}],"stop_reason":"tool_use"}}
        """)
        expect(claude.phase == .running, "Claude phase")
        expect(claude.info.title == "检查当前项目", "Claude task title")
        expect(claude.info.action == "运行命令：运行测试", "Claude tool action")

        let claudeTitle = TaskExtractors.claude(from: """
        {"type":"queue-operation","operation":"enqueue","content":"继续"}
        {"type":"custom-title","customTitle":"DeepSeek harness local install"}
        """)
        expect(claudeTitle.info.title == "继续" && claudeTitle.info.sessionName == "DeepSeek harness local install", "Claude separates session title from current task")

        let claudeIdentity = TaskExtractors.claude(from: """
        {"type":"user","sessionId":"claude-session","cwd":"/tmp/claude","entrypoint":"claude-desktop-3p","origin":{"kind":"human"},"message":{"role":"user","content":"<task-notification>synthetic</task-notification>"}}
        {"type":"custom-title","customTitle":"真实 Claude 任务"}
        """)
        expect(claudeIdentity.info.title == nil && claudeIdentity.info.sessionName == "真实 Claude 任务", "Claude task-notification filter and session title")
        expect(claudeIdentity.sessionID == "claude-session" && claudeIdentity.workingDirectory == "/tmp/claude", "Claude launch identity")
        expect(claudeIdentity.launchOrigin == "claude-desktop-3p", "Claude Desktop ownership is preserved")

        let claudeInvisibleResponse = TaskExtractors.claude(from: """
        {"type":"user","origin":{"kind":"human"},"message":{"role":"user","content":"真实任务"}}
        {"type":"user","origin":{"kind":"human"},"message":{"role":"user","content":"[Your previous response had no visible output. Please try again.]"}}
        """)
        expect(claudeInvisibleResponse.info.title == "真实任务", "Claude invisible-response prompt filter")

        let claudeSidechain = TaskExtractors.claude(from: """
        {"type":"user","isSidechain":false,"origin":{"kind":"human"},"message":{"role":"user","content":"顶层任务"}}
        {"type":"user","isSidechain":true,"message":{"role":"user","content":"内部子代理任务"}}
        """)
        expect(claudeSidechain.info.title == "顶层任务", "Claude sidechain prompt filter")

        let claudeNewTurn = TaskExtractors.claude(from: """
        {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"完成"}],"stop_reason":"end_turn"}}
        {"type":"user","isSidechain":false,"origin":{"kind":"human"},"message":{"role":"user","content":"新的任务"}}
        """)
        expect(claudeNewTurn.phase == .thinking && claudeNewTurn.info.action == "正在处理任务", "Claude new prompt resets completion")

        let claudeAPIError = TaskExtractors.claude(from: """
        {"type":"assistant","isApiErrorMessage":true,"message":{"role":"assistant","content":[{"type":"text","text":"API Error: unavailable"}],"stop_reason":"stop_sequence"}}
        """)
        expect(claudeAPIError.phase == .failed && claudeAPIError.info.action == "失败：API Error: unavailable", "Claude API error beats stop_sequence")

        let dsh = TaskExtractors.dsh(from: """
        {"type":"session/title","data":{"title":"桌宠开发会话"}}
        {"type":"user/message","data":{"source":{"kind":"user"},"content":[{"type":"text","text":"实现任务气泡"}]}}
        {"type":"todo/write","data":{"todos":[{"content":"检查日志","status":"completed"},{"content":"升级气泡","status":"in_progress"},{"content":"运行测试","status":"pending"}]}}
        """)
        expect(dsh.phase == .running, "DSH phase")
        expect(dsh.info.title == "实现任务气泡" && dsh.info.sessionName == "桌宠开发会话", "DSH separates session title from current task")
        expect(dsh.info.completedSteps == 1 && dsh.info.totalSteps == 3, "DSH todo progress")

        let nextDSHTurn = TaskExtractors.dsh(from: """
        {"type":"todo/write","data":{"todos":[{"content":"旧任务","status":"in_progress"}]}}
        {"type":"turn/start","data":{"turn":2}}
        {"type":"user/message","data":{"source":{"kind":"user"},"content":[{"type":"text","text":"新任务"}]}}
        """)
        expect(nextDSHTurn.info.totalSteps == nil && nextDSHTurn.info.title == "新任务", "DSH clears previous-turn todo")

        let dshIdentity = TaskExtractors.dsh(from: #"{"type":"session","id":"dsh-session","cwd":"/tmp/dsh"}"#)
        expect(dshIdentity.sessionID == "dsh-session" && dshIdentity.workingDirectory == "/tmp/dsh", "DSH launch identity")
        expect(
            DSHMonitor.sessionID(from: "/tmp/session-e6fdd9a8-ce56-45cf-a5e3-c92d1d730b2f/session.jsonl.zstd")
                == "session-e6fdd9a8-ce56-45cf-a5e3-c92d1d730b2f",
            "DSH filesystem identity preserves client session prefix"
        )
        expect(
            DSHMonitor.isTopLevelSessionPath("/tmp/session-parent/session.jsonl.zstd")
                && !DSHMonitor.isTopLevelSessionPath("/tmp/child-uuid/session.jsonl.zstd"),
            "DSH task monitor excludes subagent logs"
        )

        let grok = TaskExtractors.grok(from: """
        {"ts":"2020-01-01T00:00:00Z","lvl":"debug","sid":"s1","msg":"turn.phase_transition","ctx":{"to":"thinking"}}
        {"ts":"2020-01-01T00:00:01Z","lvl":"info","sid":"s1","msg":"turn.complete","ctx":{"ok":true}}
        {"ts":"2030-01-01T00:00:00Z","lvl":"info","msg":"auth.sleep.gate_cleared"}
        {"ts":"2031-01-01T00:00:00Z","lvl":"error","msg":"oidc refresh failed"}
        """, projectTitle: "all-pet", activeSessionIDs: ["s1"])
        expect(grok.phase == .done, "Grok completion")
        expect(grok.info.sessionName == "all-pet" && grok.info.title == nil, "Grok project session title")
        expect(grok.sessionID == "s1", "Grok action keeps its session id")
        expect(grok.activityAt.map { Calendar(identifier: .gregorian).component(.year, from: $0) } == 2020, "Grok ignores housekeeping timestamp")

        let grokTool = TaskExtractors.grok(from: """
        {"ts":"2020-01-01T00:00:00Z","lvl":"debug","sid":"s1","msg":"turn.phase_transition","ctx":{"to":"tool_running","tool_name":"Bash"}}
        """, projectTitle: nil, activeSessionIDs: ["s1"])
        expect(grokTool.phase == .running && grokTool.info.toolName == "Bash", "Grok tool_running phase")

        let grokWaiting = TaskExtractors.grok(from: """
        {"ts":"2020-01-01T00:00:00Z","lvl":"debug","sid":"s1","msg":"turn.phase_transition","ctx":{"to":"waiting_task_output"}}
        """, projectTitle: nil, activeSessionIDs: ["s1"])
        expect(grokWaiting.phase == .waiting, "Grok waiting_task_output phase")

        let grokToolFailure = TaskExtractors.grok(from: """
        {"ts":"2020-01-01T00:00:00Z","lvl":"info","sid":"s1","msg":"shell.tool.exec_done","ctx":{"tool_name":"Bash","success":false}}
        """, projectTitle: nil, activeSessionIDs: ["s1"])
        expect(grokToolFailure.phase == .failed, "Grok failed tool execution")

        let grokConcurrent = TaskExtractors.grok(from: """
        {"ts":"2020-01-01T00:00:02Z","lvl":"debug","sid":"s1","msg":"turn.phase_transition","ctx":{"to":"thinking"}}
        {"ts":"2020-01-01T00:00:03Z","lvl":"info","sid":"s2","msg":"turn.complete","ctx":{"ok":true}}
        """, projectTitle: nil, activeSessionIDs: ["s1", "s2"])
        expect(grokConcurrent.phase == .thinking && grokConcurrent.sessionID == "s1", "Grok active session outranks completed peer")
        expect(!TaskInfo(sessionID: "identity-only").isEmpty,
               "Terminal task identity survives after visible activity becomes idle")
        do {
            let binding = TerminalBinding(tty: "ttys008", anchorProcessID: 687, anchorStartedAtMicroseconds: 123)
            let roundTrip = try JSONDecoder().decode(TerminalBinding.self, from: JSONEncoder().encode(binding))
            expect(roundTrip == binding && roundTrip.tty == "/dev/ttys008",
                   "Terminal shell binding persists across app restarts")
        } catch {
            expect(false, "Terminal binding Codable round trip")
        }

        let grokOriginFixture = FileManager.default.temporaryDirectory
            .appendingPathComponent("allpet-grok-origin-\(UUID().uuidString).jsonl")
        do {
            try Data("""
            {"ts":"2020-01-01T00:00:00Z","pid":101,"sid":"origin-session","msg":"session created","ctx":{"cwd":"/tmp/original"}}
            {"ts":"2020-01-02T00:00:00Z","pid":202,"sid":"origin-session","msg":"session.load.done","ctx":{}}
            """.utf8).write(to: grokOriginFixture)
            let origin = GrokSessionOriginLookup.origin(for: "origin-session", inLog: grokOriginFixture.path)
            expect(origin == GrokSessionOrigin(processID: 101, workingDirectory: "/tmp/original"),
                   "Grok wake retains the original session process instead of a resume process")
            let cache = GrokSessionOriginCache()
            expect(cache.origin(for: "appended-session", inLog: grokOriginFixture.path) == nil,
                   "Grok origin index caches a miss at the current EOF")
            let append = try FileHandle(forWritingTo: grokOriginFixture)
            try append.seekToEnd()
            try append.write(contentsOf: Data("\n{\"pid\":303,\"sid\":\"appended-session\",\"msg\":\"session created\",\"ctx\":{\"cwd\":\"/tmp/appended\"}}\n".utf8))
            try append.close()
            expect(cache.origin(for: "appended-session", inLog: grokOriginFixture.path)?.processID == 303,
                   "Grok origin index scans only bytes appended after a cached miss")
        } catch {
            expect(false, "Grok original-session fixture")
        }
        try? FileManager.default.removeItem(at: grokOriginFixture)
        let noNewlineGrokFixture = FileManager.default.temporaryDirectory
            .appendingPathComponent("allpet-grok-no-newline-\(UUID().uuidString).jsonl")
        do {
            try Data("{\"pid\":505,\"sid\":\"eof-session\",\"msg\":\"session created\",\"ctx\":{}}".utf8).write(to: noNewlineGrokFixture)
            expect(GrokSessionOriginLookup.origin(for: "eof-session", inLog: noNewlineGrokFixture.path)?.processID == 505,
                   "Grok origin index parses a complete final record without newline")
        } catch {
            expect(false, "Grok no-newline origin fixture")
        }
        try? FileManager.default.removeItem(at: noNewlineGrokFixture)
        let largeGrokFixture = FileManager.default.temporaryDirectory
            .appendingPathComponent("allpet-grok-large-\(UUID().uuidString).jsonl")
        do {
            FileManager.default.createFile(atPath: largeGrokFixture.path, contents: nil)
            let handle = try FileHandle(forWritingTo: largeGrokFixture)
            try handle.truncate(atOffset: 65 * 1_024 * 1_024)
            try handle.seekToEnd()
            try handle.write(contentsOf: Data("\n{\"pid\":404,\"sid\":\"after-64m\",\"msg\":\"session created\",\"ctx\":{}}\n".utf8))
            try handle.close()
            expect(GrokSessionOriginLookup.origin(for: "after-64m", inLog: largeGrokFixture.path)?.processID == 404,
                   "Grok origin index finds sessions created after the first 64 MiB")
        } catch {
            expect(false, "Grok large-log origin fixture")
        }
        try? FileManager.default.removeItem(at: largeGrokFixture)
        let fakeHome = URL(fileURLWithPath: "/Users/test")
        expect(
            GrokTerminalTargetResolver.isRecognizedExecutable(
                URL(fileURLWithPath: "/Users/test/.grok/downloads/grok-0.2.118-macos-aarch64"), home: fakeHome
            ) && !GrokTerminalTargetResolver.isRecognizedExecutable(
                URL(fileURLWithPath: "/tmp/grok-0.2.118-macos-aarch64"), home: fakeHome
            ),
            "Grok terminal ownership accepts only the installed versioned executable"
        )

        let dshBlocked = TaskExtractors.dsh(from: """
        {"type":"turn/end","data":{"reason":{"kind":"blocked"}}}
        """)
        expect(dshBlocked.phase == .waiting, "DSH blocked is waiting")

        let dshMaxTokens = TaskExtractors.dsh(from: """
        {"type":"turn/end","data":{"reason":{"kind":"max-tokens"}}}
        """)
        expect(dshMaxTokens.phase == .failed, "DSH max-tokens is failed")

        let codexAnimations = PetAnimation.allCases
        let codexAnimationNames = [
            "idle", "running-right", "running-left", "waving", "jumping",
            "failed", "waiting", "running", "review"
        ]
        expect(codexAnimations.map(\.rawValue) == codexAnimationNames, "Codex nine standard pet states")
        expect(codexAnimations.enumerated().allSatisfy { $0.element.row == $0.offset }, "Codex standard state rows")
        let codexDurations = [
            [1_680, 660, 660, 840, 840, 1_920],
            [120, 120, 120, 120, 120, 120, 120, 220],
            [120, 120, 120, 120, 120, 120, 120, 220],
            [140, 140, 140, 280],
            [140, 140, 140, 140, 280],
            [140, 140, 140, 140, 140, 140, 140, 240],
            [150, 150, 150, 150, 150, 260],
            [120, 120, 120, 120, 120, 220],
            [150, 150, 150, 150, 150, 280]
        ]
        expect(codexAnimations.map(\.actionFrameDurationsMilliseconds) == codexDurations, "Codex exact frame timings")
        let runningPlayback = PetAnimation.running.playback()
        expect(runningPlayback.frames.count == 24 && runningPlayback.loopStartIndex == 18, "Codex action settles into idle")
        let reducedPlayback = PetAnimation.review.playback(reduceMotion: true)
        expect(reducedPlayback.frames.count == 1 && reducedPlayback.loopStartIndex == nil, "Codex reduced motion frame")

        let watch = WatchConfig(activeWindowSeconds: 8, waitingWindowSeconds: 120)
        expect(
            PhaseClassifier.resolved(inferred: .waiting, parsed: .running, age: 20, config: watch) == .waiting,
            "Stalled active phase becomes waiting"
        )
        expect(
            PhaseClassifier.resolved(inferred: .waiting, parsed: .done, age: 20, config: watch) == .done,
            "Terminal phase persists during waiting window"
        )

        let tailFixture = FileManager.default.temporaryDirectory
            .appendingPathComponent("allpet-tail-\(UUID().uuidString).jsonl")
        do {
            let content = String(repeating: "你", count: 300) + "\n{\"type\":\"tail\"}\n"
            try content.data(using: .utf8)?.write(to: tailFixture)
            let tail = ActivityScanner.readTail(tailFixture.path, maxBytes: 64)
            expect(tail.contains("{\"type\":\"tail\"}"), "UTF-8 tail starts on complete JSONL line")

            let attrs = try FileManager.default.attributesOfItem(atPath: tailFixture.path)
            let mtime = attrs[.modificationDate] as? Date ?? .distantPast
            let size = (attrs[.size] as? NSNumber)?.uint64Value ?? 0
            let cache = TaskParseCache()
            var parseCount = 0
            for _ in 0..<2 {
                _ = cache.parse(path: tailFixture.path, mtime: mtime, size: size, maxBytes: 64) { text in
                    parseCount += 1
                    return ParsedTask(detail: text)
                }
            }
            expect(parseCount == 1, "Unchanged task log uses parse cache")
        } catch {
            expect(false, "UTF-8 tail fixture")
        }
        try? FileManager.default.removeItem(at: tailFixture)

        let codexOriginFixture = FileManager.default.temporaryDirectory
            .appendingPathComponent("allpet-codex-origin-\(UUID().uuidString)")
        do {
            try FileManager.default.createDirectory(at: codexOriginFixture, withIntermediateDirectories: true)
            let now = Date()
            let genuine = codexOriginFixture.appendingPathComponent("genuine.jsonl")
            let dshBacked = codexOriginFixture.appendingPathComponent("dsh.jsonl")
            let partial = codexOriginFixture.appendingPathComponent("partial.jsonl")
            let subagent = codexOriginFixture.appendingPathComponent("subagent.jsonl")
            let genuineText = #"{"type":"session_meta","payload":{"id":"genuine-codex","originator":"Codex Desktop","thread_source":"vscode"}}"# + "\n"
                + #"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"真实 Codex 任务"}]}}"# + "\n"
            try Data(genuineText.utf8).write(to: genuine)
            try Data((#"{"type":"session_meta","payload":{"id":"dsh-copy","originator":"dsh-arm64-provider-test","thread_source":"dsh-arm64-provider-test"}}"# + "\n").utf8).write(to: dshBacked)
            try Data("{\"type\":\"session_meta\"".utf8).write(to: partial)
            try Data((#"{"type":"session_meta","payload":{"id":"sub-codex","originator":"Codex Desktop","thread_source":"subagent"}}"# + "\n").utf8).write(to: subagent)
            try FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(-3)], ofItemAtPath: genuine.path)
            try FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(-2)], ofItemAtPath: dshBacked.path)
            try FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(-1)], ofItemAtPath: partial.path)
            try FileManager.default.setAttributes([.modificationDate: now], ofItemAtPath: subagent.path)
            let status = CodexMonitor(roots: [codexOriginFixture.path]).snapshot(config: watch, now: now)
            expect(status.task?.sessionID == "genuine-codex" && status.activeSessions == 1, "Codex excludes DSH, partial and subagent origins")
            expect(status.task?.launchOrigin == "codex-desktop", "Codex Desktop origin is persisted for wake routing")
            let cli = codexOriginFixture.appendingPathComponent("cli.jsonl")
            try Data((#"{"type":"session_meta","payload":{"session_id":"cli-codex","originator":"codex_cli_rs","source":"cli"}}"# + "\n").utf8).write(to: cli)
            expect(CodexTranscriptIdentityLookup.read(path: cli.path).launchOrigin == "codex-cli",
                   "Codex CLI origin is distinguished from Desktop")
        } catch {
            expect(false, "Codex origin fixture")
        }
        try? FileManager.default.removeItem(at: codexOriginFixture)

        let claudeSubagentFixture = FileManager.default.temporaryDirectory
            .appendingPathComponent("allpet-claude-subagent-\(UUID().uuidString)")
        do {
            try FileManager.default.createDirectory(at: claudeSubagentFixture, withIntermediateDirectories: true)
            let now = Date()
            let top = claudeSubagentFixture.appendingPathComponent("main.jsonl")
            let subdir = claudeSubagentFixture.appendingPathComponent("subagents")
            try FileManager.default.createDirectory(at: subdir, withIntermediateDirectories: true)
            let sub = subdir.appendingPathComponent("agent-1.jsonl")
            try Data((#"{"type":"user","origin":{"kind":"human"},"message":{"role":"user","content":"顶层任务"}}"# + "\n").utf8).write(to: top)
            try Data((#"{"type":"user","origin":{"kind":"human"},"message":{"role":"user","content":"子代理任务"}}"# + "\n").utf8).write(to: sub)
            try FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(-1)], ofItemAtPath: top.path)
            try FileManager.default.setAttributes([.modificationDate: now], ofItemAtPath: sub.path)
            let status = ClaudeMonitor(roots: [claudeSubagentFixture.path]).snapshot(config: watch, now: now)
            expect(status.task?.title == "顶层任务" && status.activeSessions == 1, "Claude excludes subagents transcript files")
        } catch {
            expect(false, "Claude subagent fixture")
        }
        try? FileManager.default.removeItem(at: claudeSubagentFixture)

        let scanFixture = FileManager.default.temporaryDirectory
            .appendingPathComponent("allpet-scan-\(UUID().uuidString)")
        do {
            try FileManager.default.createDirectory(at: scanFixture, withIntermediateDirectories: true)
            let specs: [(String, TimeInterval)] = [("A.jsonl", 0), ("B.jsonl", 120), ("C.jsonl", 130)]
            for (name, timestamp) in specs {
                let url = scanFixture.appendingPathComponent(name)
                try Data("{}\n".utf8).write(to: url)
                try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: timestamp)], ofItemAtPath: url.path)
            }
            let scan = ActivityScanner.scan(
                roots: [scanFixture.path],
                isIncluded: { $0.hasSuffix(".jsonl") },
                recentWindow: 1_000,
                now: Date(timeIntervalSince1970: 200),
                selectionPriority: { path in
                    switch URL(fileURLWithPath: path).lastPathComponent {
                    case "A.jsonl": 2
                    case "B.jsonl": 1
                    default: 0
                    }
                },
                priorityGrace: 120
            )
            expect(scan.newestPath.map { URL(fileURLWithPath: $0).lastPathComponent } == "B.jsonl", "Priority scan uses global-newest grace window")
        } catch {
            expect(false, "Priority scan fixture")
        }
        try? FileManager.default.removeItem(at: scanFixture)

        let codexNameHome = FileManager.default.temporaryDirectory
            .appendingPathComponent("allpet-codex-name-\(UUID().uuidString)", isDirectory: true)
        do {
            let index = codexNameHome.appendingPathComponent(".codex/session_index.jsonl")
            try FileManager.default.createDirectory(at: index.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("""
            {"id":"codex-name-id","thread_name":"Old name"}
            {"id":"codex-name-id","thread_name":"Stable renamed session"}
            """.utf8).write(to: index)
            expect(CodexSessionNameLookup.name(for: "codex-name-id", home: codexNameHome) == "Stable renamed session",
                   "Codex bubbles use latest stable thread rename")
            expect(CodexSessionNameLookup.isUnique("Stable renamed session", for: "codex-name-id", home: codexNameHome),
                   "Unique Codex session name is bound to its session ID")
            let duplicate = try FileHandle(forWritingTo: index)
            try duplicate.seekToEnd()
            try duplicate.write(contentsOf: Data("\n{\"id\":\"another-id\",\"thread_name\":\"Stable renamed session\"}\n".utf8))
            try duplicate.close()
            expect(!CodexSessionNameLookup.isUnique("Stable renamed session", for: "codex-name-id", home: codexNameHome),
                   "Duplicate Codex names fail closed instead of proving the wrong thread")
        } catch {
            expect(false, "Codex session-name fixture")
        }
        try? FileManager.default.removeItem(at: codexNameHome)

        let claudeMetadataFixture = FileManager.default.temporaryDirectory
            .appendingPathComponent("allpet-claude-metadata-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: claudeMetadataFixture, withIntermediateDirectories: true)
            let records: [(String, Double, Bool)] = [
                ("local_archived", 10, true),
                ("local_original-random", 20, false),
                ("local_cli-session", 30, false)
            ]
            for (sessionID, createdAt, archived) in records {
                let object: [String: Any] = [
                    "sessionId": sessionID, "cliSessionId": "cli-session",
                    "createdAt": createdAt, "lastFocusedAt": createdAt + 1, "isArchived": archived,
                    "title": sessionID == "local_original-random" ? "Original Claude Session" : "Other"
                ]
                try JSONSerialization.data(withJSONObject: object).write(
                    to: claudeMetadataFixture.appendingPathComponent("\(sessionID).json")
                )
            }
            let match = ClaudeDesktopSessionLookup.originalSession(forCLI: "cli-session", roots: [claudeMetadataFixture])
            expect(match?.sessionID == "local_original-random" && match?.title == "Original Claude Session",
                   "Claude resolves oldest non-archived Desktop task and title")
            expect(ClaudeDesktopSessionLookup.originalSession(forCLI: "cli-session", roots: [claudeMetadataFixture], maximumFiles: 2) == nil,
                   "Claude metadata lookup fails closed when scan is truncated")
            let capA = claudeMetadataFixture.appendingPathComponent("cap-a", isDirectory: true)
            let capB = claudeMetadataFixture.appendingPathComponent("cap-b", isDirectory: true)
            try FileManager.default.createDirectory(at: capA, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: capB, withIntermediateDirectories: true)
            for index in 0..<2 {
                try JSONSerialization.data(withJSONObject: [
                    "sessionId": "local_other-\(index)", "cliSessionId": "other-\(index)", "createdAt": index
                ]).write(to: capA.appendingPathComponent("\(index).json"))
            }
            try JSONSerialization.data(withJSONObject: [
                "sessionId": "local_cross-root", "cliSessionId": "cross-root", "createdAt": 1
            ]).write(to: capB.appendingPathComponent("target.json"))
            expect(ClaudeDesktopSessionLookup.originalSession(forCLI: "cross-root", roots: [capA, capB], maximumFiles: 2) == nil,
                   "Claude metadata cap probes later roots and fails closed")
            expect(ClaudeDesktopSessionLookup.session(withID: "local_original-random", roots: [claudeMetadataFixture])?.lastFocusedAt == 21,
                   "Claude exact focus record is readable")
            expect(ClaudeDesktopSessionLookup.session(withID: "local_original-random", roots: [claudeMetadataFixture])?.cliSessionID == "cli-session",
                   "Claude Desktop task maps back to its CLI session for strong-wake choice")
            let transcript = claudeMetadataFixture.appendingPathComponent("legacy.jsonl")
            try Data("""
            {"type":"user","entrypoint":"cli","message":{"role":"user","content":"task"}}
            {"type":"custom-title","customTitle":"Stable CLI Session"}
            """.utf8).write(to: transcript)
            let identity = ClaudeTranscriptIdentityLookup.read(path: transcript.path)
            expect(identity.launchOrigin == "cli" && identity.customTitle == "Stable CLI Session",
                   "Claude legacy transcript identity recovers origin and session name")
        } catch {
            expect(false, "Claude metadata fixture")
        }
        try? FileManager.default.removeItem(at: claudeMetadataFixture)

        let petAdapterFixture = FileManager.default.temporaryDirectory
            .appendingPathComponent("allpet-pet-adapters-\(UUID().uuidString)", isDirectory: true)
        do {
            func writeImage(_ url: URL, _ color: NSColor) throws {
                guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 4, pixelsHigh: 4,
                    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else {
                    throw PetModelImportError.installFailed("测试图片")
                }
                for x in 0..<4 { for y in 0..<4 { bitmap.setColor(color, atX: x, y: y) } }
                guard let data = bitmap.representation(using: .png, properties: [:]) else {
                    throw PetModelImportError.installFailed("测试图片编码")
                }
                try data.write(to: url)
            }
            func writeAtlasImage(_ url: URL, width: Int, height: Int, color: NSColor) throws {
                guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
                    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
                      let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
                    throw PetModelImportError.installFailed("测试 V2 图集")
                }
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = context
                color.setFill()
                NSRect(x: 0, y: 0, width: width, height: height).fill()
                NSGraphicsContext.restoreGraphicsState()
                guard let data = bitmap.representation(using: .png, properties: [:]) else {
                    throw PetModelImportError.installFailed("测试 V2 图集编码")
                }
                try data.write(to: url)
            }
            func solidImage(_ color: NSColor) throws -> CGImage {
                guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 4, pixelsHigh: 4,
                    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else {
                    throw PetModelImportError.installFailed("测试 GIF 帧")
                }
                for x in 0..<4 { for y in 0..<4 { bitmap.setColor(color, atX: x, y: y) } }
                guard let image = bitmap.cgImage else { throw PetModelImportError.installFailed("测试 GIF 帧") }
                return image
            }
            func writeAnimatedGIF(_ url: URL, _ colors: [NSColor]) throws {
                guard let destination = CGImageDestinationCreateWithURL(url as CFURL, "com.compuserve.gif" as CFString, colors.count, nil) else {
                    throw PetModelImportError.installFailed("测试 GIF")
                }
                let properties: [CFString: Any] = [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: 0.1]]
                for color in colors { CGImageDestinationAddImage(destination, try solidImage(color), properties as CFDictionary) }
                guard CGImageDestinationFinalize(destination) else { throw PetModelImportError.installFailed("测试 GIF 编码") }
            }
            let home = petAdapterFixture.appendingPathComponent("home", isDirectory: true)
            let cc = petAdapterFixture.appendingPathComponent("cc-haha/pets/tiny", isDirectory: true)
            try FileManager.default.createDirectory(at: cc, withIntermediateDirectories: true)
            try writeImage(cc.appendingPathComponent("pet.png"), NSColor(deviceRed: 1, green: 0, blue: 0, alpha: 1))
            let ccManifest: [String: Any] = [
                "displayName": "Tiny", "manifestVersion": 1,
                "renderer": ["kind": "single-image", "version": 1, "imagePath": "pet.png"]
            ]
            try JSONSerialization.data(withJSONObject: ccManifest).write(to: cc.appendingPathComponent("pet.json"))
            let ccResult = try PetModelImporter.importModel(from: cc, home: home)
            expect(ccResult.sourceKind == .ccHaha && ccResult.normalized, "cc-haha single-image adapter")
            expect(ccResult.bundle.atlas.pixelWidth == 1_536 && ccResult.bundle.atlas.pixelHeight == 1_872, "Imported adapter atlas geometry")

            let ccV2 = petAdapterFixture.appendingPathComponent("cc-haha/pets/v2-no-id", isDirectory: true)
            try FileManager.default.createDirectory(at: ccV2, withIntermediateDirectories: true)
            try writeAtlasImage(ccV2.appendingPathComponent("atlas.png"), width: 1_536, height: 2_288,
                                color: NSColor(deviceRed: 0.2, green: 0.4, blue: 0.8, alpha: 1))
            try JSONSerialization.data(withJSONObject: [
                "displayName": "V2 No ID", "spritesheetPath": "atlas.png", "spriteVersionNumber": 2
            ])
                .write(to: ccV2.appendingPathComponent("pet.json"))
            let ccV2Result = try PetModelImporter.importModel(from: ccV2, home: home)
            expect(ccV2Result.sourceKind == .ccHaha && !ccV2Result.normalized && ccV2Result.bundle.manifest.id == "v2-no-id"
                   && ccV2Result.bundle.atlas.rows == 11,
                   "cc-haha V2 derives omitted id from directory")

            let petdexDefault = petAdapterFixture.appendingPathComponent("petdex-default", isDirectory: true)
            try FileManager.default.createDirectory(at: petdexDefault, withIntermediateDirectories: true)
            try writeAtlasImage(petdexDefault.appendingPathComponent("spritesheet.webp"), width: 1_536, height: 2_288,
                                color: NSColor(deviceRed: 0.1, green: 0.8, blue: 0.3, alpha: 1))
            try JSONSerialization.data(withJSONObject: [
                "id": "cat-hamster-duo", "displayName": "团团和米粒", "description": "自定义宠物"
            ]).write(to: petdexDefault.appendingPathComponent("pet.json"))
            let petdexResult = try PetModelImporter.importModel(from: petdexDefault, home: home)
            expect(petdexResult.sourceKind == .codexAtlas && !petdexResult.normalized
                   && petdexResult.bundle.manifest.id == "cat-hamster-duo"
                   && petdexResult.bundle.atlas.rows == 11,
                   "petdex default spritesheet.webp without spritesheetPath field")

            let generic = petAdapterFixture.appendingPathComponent("generic-single", isDirectory: true)
            try FileManager.default.createDirectory(at: generic, withIntermediateDirectories: true)
            try writeImage(generic.appendingPathComponent("pet.png"), NSColor(deviceRed: 1, green: 0.5, blue: 0, alpha: 1))
            try JSONSerialization.data(withJSONObject: [
                "displayName": "Private Pet", "sourceProject": "local://private", "sourceLicense": "Private",
                "manifestVersion": 1, "renderer": ["kind": "single-image", "version": 1, "imagePath": "pet.png"]
            ]).write(to: generic.appendingPathComponent("pet.json"))
            let genericResult = try PetModelImporter.importModel(from: generic, home: home)
            let genericStored = (try? JSONSerialization.jsonObject(with: Data(contentsOf: genericResult.bundle.directoryURL.appendingPathComponent("pet.json"))) as? [String: Any])
            expect(genericResult.sourceKind == .localSingleImage
                   && genericStored?["sourceLicense"] as? String == "Private",
                   "Generic single-image preserves provenance without cc-haha attribution")
            let permissions = (try FileManager.default.attributesOfItem(atPath: genericResult.bundle.directoryURL.path)[.posixPermissions] as? NSNumber)?.intValue
            expect(permissions == 0o700, "Imported pet directory is private")

            let future = petAdapterFixture.appendingPathComponent("cc-haha/pets/future", isDirectory: true)
            try FileManager.default.createDirectory(at: future, withIntermediateDirectories: true)
            try writeImage(future.appendingPathComponent("pet.png"), NSColor(deviceRed: 1, green: 0, blue: 1, alpha: 1))
            try JSONSerialization.data(withJSONObject: [
                "manifestVersion": 1,
                "renderer": ["kind": "single-image", "version": 1, "imagePath": "pet.png", "motionProfile": "future-profile"]
            ]).write(to: future.appendingPathComponent("pet.json"))
            var futureRejected = false
            do { _ = try PetModelImporter.importModel(from: future, home: home) } catch { futureRejected = true }
            expect(futureRejected, "cc-haha importer rejects unsupported motion profiles")

            let ling = petAdapterFixture.appendingPathComponent("ling", isDirectory: true)
            let avatars = ling.appendingPathComponent("avatar", isDirectory: true)
            try FileManager.default.createDirectory(at: avatars, withIntermediateDirectories: true)
            try Data("ai_name: Ling Test\ntitle: Alternate\n".utf8).write(to: ling.appendingPathComponent("settings.yml"))
            try writeImage(avatars.appendingPathComponent("平静.png"), NSColor(deviceRed: 0, green: 0, blue: 1, alpha: 1))
            try writeImage(avatars.appendingPathComponent("高兴.png"), NSColor(deviceRed: 0, green: 1, blue: 0, alpha: 1))
            let lingResult = try PetModelImporter.importModel(from: ling, home: home)
            expect(lingResult.sourceKind == .lingChat && lingResult.bundle.manifest.displayName.contains("Ling Test"), "LingChat avatar adapter")
            if let source = CGImageSourceCreateWithURL(lingResult.bundle.spritesheetURL as CFURL, nil),
               let atlasImage = CGImageSourceCreateImageAtIndex(source, 0, nil),
               let idleFrame = atlasImage.cropping(to: CGRect(x: 0, y: 0, width: 192, height: 208)),
               let happyFrame = atlasImage.cropping(to: CGRect(x: 0, y: 3 * 208, width: 192, height: 208)),
               let idleColor = NSBitmapImageRep(cgImage: idleFrame).colorAt(x: 96, y: 104)?.usingColorSpace(.deviceRGB),
               let happyColor = NSBitmapImageRep(cgImage: happyFrame).colorAt(x: 96, y: 104)?.usingColorSpace(.deviceRGB) {
                expect((idleColor.blueComponent > idleColor.greenComponent) && (happyColor.greenComponent > happyColor.blueComponent),
                       "Imported atlas preserves logical row order")
            } else {
                expect(false, "Imported atlas row probe")
            }

            let project = petAdapterFixture.appendingPathComponent("clawd", isDirectory: true)
            let theme = project.appendingPathComponent("themes/clawd", isDirectory: true)
            let gifs = project.appendingPathComponent("assets/gif", isDirectory: true)
            let themeAssets = theme.appendingPathComponent("assets", isDirectory: true)
            try FileManager.default.createDirectory(at: themeAssets, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: gifs, withIntermediateDirectories: true)
            let themeObject: [String: Any] = [
                "name": "Clawd Test",
                "states": [
                    "idle": ["clawd-idle.svg"], "roam": ["clawd-mini-crabwalk.svg"],
                    "attention": ["clawd-happy.svg"], "error": ["clawd-error.svg"],
                    "thinking": ["clawd-thinking.svg"], "working": ["clawd-typing.svg"]
                ]
            ]
            try JSONSerialization.data(withJSONObject: themeObject).write(to: theme.appendingPathComponent("theme.json"))
            for name in ["idle", "mini-crabwalk", "error", "thinking", "typing"] {
                try writeImage(gifs.appendingPathComponent("clawd-\(name).gif"), NSColor(deviceRed: 0.5, green: 0, blue: 0.8, alpha: 1))
            }
            try FileManager.default.removeItem(at: gifs.appendingPathComponent("clawd-idle.gif"))
            try writeAnimatedGIF(gifs.appendingPathComponent("clawd-idle.gif"), [
                NSColor(deviceRed: 1, green: 0, blue: 0, alpha: 1),
                NSColor(deviceRed: 0, green: 1, blue: 0, alpha: 1),
                NSColor(deviceRed: 0, green: 0, blue: 1, alpha: 1),
                NSColor(deviceRed: 1, green: 1, blue: 0, alpha: 1)
            ])
            try Data(##"<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#00ff00"/></svg>"##.utf8)
                .write(to: themeAssets.appendingPathComponent("clawd-happy.svg"))
            let clawdResult = try PetModelImporter.importModel(from: project, home: home)
            expect(clawdResult.sourceKind == .clawdOnDesk && clawdResult.bundle.manifest.displayName.contains("Clawd Test"),
                   "clawd-on-desk theme adapter")
            if let source = CGImageSourceCreateWithURL(clawdResult.bundle.spritesheetURL as CFURL, nil),
               let atlasImage = CGImageSourceCreateImageAtIndex(source, 0, nil),
               let finalIdle = atlasImage.cropping(to: CGRect(x: 5 * 192, y: 0, width: 192, height: 208)),
               let finalFallback = atlasImage.cropping(to: CGRect(x: 4 * 192, y: 4 * 208, width: 192, height: 208)),
               let color = NSBitmapImageRep(cgImage: finalIdle).colorAt(x: 96, y: 104)?.usingColorSpace(.deviceRGB),
               let fallbackColor = NSBitmapImageRep(cgImage: finalFallback).colorAt(x: 96, y: 104)?.usingColorSpace(.deviceRGB) {
                expect(color.redComponent > 0.8 && color.greenComponent > 0.8 && color.blueComponent < 0.2
                       && fallbackColor.redComponent > 0.8 && fallbackColor.greenComponent > 0.8 && fallbackColor.blueComponent < 0.2,
                       "Animated import maps final source frame into runtime prefixes and fallbacks")
            } else {
                expect(false, "Animated import endpoint probe")
            }
            let explicitClawd = try PetModelImporter.importModel(from: theme.appendingPathComponent("theme.json"), home: home)
            expect(explicitClawd.sourceKind == .clawdOnDesk,
                   "Explicit clawd theme.json reaches canonical checkout assets")

            let unsafe = petAdapterFixture.appendingPathComponent("unsafe", isDirectory: true)
            try FileManager.default.createDirectory(at: unsafe, withIntermediateDirectories: true)
            let unsafeManifest: [String: Any] = [
                "id": "unsafe", "manifestVersion": 1,
                "renderer": ["kind": "single-image", "version": 1, "imagePath": "../outside.png"]
            ]
            try JSONSerialization.data(withJSONObject: unsafeManifest).write(to: unsafe.appendingPathComponent("pet.json"))
            var traversalRejected = false
            do { _ = try PetModelImporter.importModel(from: unsafe, home: home) } catch { traversalRejected = true }
            expect(traversalRejected, "Pet adapter rejects traversal assets")
            let stale = home.appendingPathComponent(".config/all-pet/pets/.import-crash", isDirectory: true)
            try FileManager.default.createDirectory(at: stale, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: ccResult.bundle.spritesheetURL, to: stale.appendingPathComponent("spritesheet.png"))
            try JSONSerialization.data(withJSONObject: ["id": "stale", "spritesheetPath": "spritesheet.png"])
                .write(to: stale.appendingPathComponent("pet.json"))
            expect(PetDiscovery.discover(home: home).count == 5 + BundledPets.slugs.count,
                   "Imported pets are discoverable; hidden staging ignored and bundled pets materialize")
        } catch {
            expect(false, "Pet adapter fixtures: \(error.localizedDescription)")
        }
        try? FileManager.default.removeItem(at: petAdapterFixture)

        // PetRegistry：预设匹配与入口自动探测。
        expect(PetRegistry.preset(matching: "cc-haha")?.id == "cc-haha", "Pet registry resolves preset by id")
        expect(PetRegistry.preset(matching: "https://github.com/rullerzhou-afk/clawd-on-desk")?.id == "clawd-on-desk",
               "Pet registry resolves preset by repository URL")
        expect(PetRegistry.preset(matching: "lingchat")?.kind == .lingChat, "Pet registry resolves LingChat preset")
        expect(PetRegistry.preset(matching: "totally-unknown-pet") == nil, "Pet registry rejects unknown preset")
        let registryFixture = FileManager.default.temporaryDirectory
            .appendingPathComponent("allpet-registry-\(UUID().uuidString)", isDirectory: true)
        do {
            for dir in ["themes/clawd", "themes/calico", "pets/demo"] {
                try FileManager.default.createDirectory(at: registryFixture.appendingPathComponent(dir),
                    withIntermediateDirectories: true)
            }
            try Data("{}".utf8).write(to: registryFixture.appendingPathComponent("themes/clawd/theme.json"))
            try Data("{}".utf8).write(to: registryFixture.appendingPathComponent("themes/calico/theme.json"))
            try Data("{}".utf8).write(to: registryFixture.appendingPathComponent("pets/demo/pet.json"))
            try Data("name: demo".utf8).write(to: registryFixture.appendingPathComponent("settings.yml"))
            let clawdEntry = PetRegistry.entrypoint(in: registryFixture, kind: .clawdOnDesk)
            expect(clawdEntry?.path.contains("/themes/clawd/theme.json") == true,
                   "Pet registry prefers canonical clawd theme entrypoint")
            let codexEntry = PetRegistry.entrypoint(in: registryFixture, kind: .ccHaha)
            expect(codexEntry?.path.contains("/pets/demo/pet.json") == true,
                   "Pet registry prefers pet.json under pets/")
            let lingEntry = PetRegistry.entrypoint(in: registryFixture, kind: .lingChat)
            expect(lingEntry?.path.hasSuffix("/settings.yml") == true,
                   "Pet registry finds LingChat settings.yml")
        } catch {
            expect(false, "Pet registry fixtures: \(error.localizedDescription)")
        }
        try? FileManager.default.removeItem(at: registryFixture)

        let bubble = PlatformStatus(
            platform: .dsh,
            phase: .running,
            detail: "运行中",
            lastActivityAt: nil,
            activeSessions: 1,
            enabled: true,
            task: TaskInfo(sessionName: "桌宠开发会话", title: "实现任务气泡", action: "升级气泡", completedSteps: 1, totalSteps: 3)
        )
        expect(bubble.bubbleHeader == "DSH · 运行中", "Bubble header")
        expect(bubble.bubbleDetails == ["进度 1/3 · 升级气泡", "会话：桌宠开发会话"], "Bubble hides current task title")

        return AllPetSelfTestReport(checks: checks, failures: failures)
    }
}
#else
public enum AllPetSelfTest {
    public static func run() -> AllPetSelfTestReport {
        AllPetSelfTestReport(checks: 0, failures: ["self-test 仅支持 macOS"])
    }
}
#endif
