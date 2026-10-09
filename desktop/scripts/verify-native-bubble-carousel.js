'use strict'
// Compiles the actual TaskTrayView with a same-file fixture extension; no production test hooks or user data.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { spawnSync } = require('node:child_process')
if (process.platform !== 'darwin') throw Error('Native bubble verification requires macOS')
const root = path.resolve(__dirname, '../..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'allpet-native-carousel-'))
function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: root, encoding: 'utf8', timeout: 60000, ...options })
  if (result.error || result.status !== 0) throw Error([result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n'))
  return result.stdout.trim()
}
try {
  const build = process.env.ALLPET_NATIVE_BUILD_DIR || run('swift', ['build', '-c', 'release', '--show-bin-path']).split(/\r?\n/).at(-1)
  const objects = fs.readdirSync(path.join(build, 'AllPetCore.build')).filter(name => name.endsWith('.o')).map(name => path.join(build, 'AllPetCore.build', name))
  const source = path.join(temporary, 'Fixture.swift'), binary = path.join(temporary, 'fixture')
  // Replace only the system preference input in the isolated compiled fixture.
  // AppKit on CI may default to Reduce Motion; production continues reading NSWorkspace.
  const viewSource = fs.readFileSync(path.join(root, 'Sources/allpet/TaskTrayView.swift'), 'utf8')
    .replaceAll('NSWorkspace.shared.accessibilityDisplayShouldReduceMotion', 'NativeCarouselFixture.reduceMotion')
  fs.writeFileSync(source, viewSource + `
extension TaskTrayView {
    fileprivate var fixtureFrontID: String? {
        let items = unfinishedPlatformBubbles
        return items.isEmpty ? nil : items[rotationIndex % items.count].taskID
    }
    fileprivate var fixtureTimer: Bool { rotationTimer != nil }
    fileprivate var fixtureDismissID: String? {
        hitRegions.compactMap { region -> String? in
            if case let .dismissTask(id) = region.target { return id }; return nil
        }.last
    }
}
@main enum NativeCarouselFixture {
    static var reduceMotion = false
    static func wait() { RunLoop.current.run(until: Date().addingTimeInterval(3.4)) }
    static func check(_ condition: @autoclosure () -> Bool, _ message: String) {
        if !condition() { fatalError(message) }
    }
    static func status(_ platform: PlatformKind, _ name: String, _ time: Double) -> PlatformStatus {
        PlatformStatus(platform: platform, phase: .running, detail: "Fixture", lastActivityAt: Date(timeIntervalSince1970: time), activeSessions: 1, enabled: true,
            task: TaskInfo(sessionName: name, title: name, action: "Fixture", sessionID: name))
    }
    static func main() throws {
        let app = NSApplication.shared; app.setActivationPolicy(.prohibited)
        let policy = PetMotionPolicy.plan(reduceMotion: false, stageIsCollapsed: true, hasActiveTask: true, unfinishedPlatformCount: 1, unfinishedTaskCount: 3)
        check(policy.rotatesPlatforms, "Single platform task timer policy")
        check(!PetMotionPolicy.plan(reduceMotion: true, stageIsCollapsed: true, hasActiveTask: true, unfinishedPlatformCount: 1, unfinishedTaskCount: 3).rotatesPlatforms, "Reduced motion freezes tasks")
        var algorithm = TaskBubbleCarousel()
        algorithm.reconcile([.init(platform: "codex", taskIDs: ["A", "B"]), .init(platform: "claude", taskIDs: ["C", "D"])])
        var cycle: [String] = []
        for _ in 0..<6 {
            let platform = ["codex", "claude"][algorithm.platformIndex]
            cycle.append(algorithm.selectedTaskID(for: platform)!); algorithm.advance()
        }
        check(cycle == ["A", "C", "B", "D", "A", "C"], "Common divisor must not skip tasks")
        let codex = status(.codex, "Alpha", 3), claude = status(.claude, "Delta", 4)
        let A = TrayTaskItem(status: codex), B = TrayTaskItem(status: status(.codex, "Beta", 2))
        var C = TrayTaskItem(status: status(.codex, "Gamma", 1))
        var done = TrayTaskItem(status: status(.codex, "Finished", 0)); done.phase = .done
        let view = TaskTrayView(frame: NSRect(x: 0, y: 0, width: 304, height: 131))
        view.update(statuses: [codex], tasksByPlatform: [.codex: [A, B, C, done]])
        check(view.fixtureTimer && view.fixtureFrontID == A.id, "Single platform starts real timer")
        let initialSize = view.preferredSize
        wait(); check(view.fixtureFrontID == B.id, "Native timer Alpha -> Beta")
        C.updatedAt = Date(timeIntervalSince1970: 9)
        view.update(statuses: [codex], tasksByPlatform: [.codex: [C, B, A, done]])
        check(view.fixtureFrontID == B.id, "Snapshot sorting must retain Beta")
        let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
        view.cacheDisplay(in: view.bounds, to: bitmap)
        check(view.fixtureDismissID == B.id, "Native front close button must target Beta")
        if let output = ProcessInfo.processInfo.environment["ALLPET_NATIVE_CAROUSEL_IMAGE"] {
            try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
        }
        wait(); check(view.fixtureFrontID == C.id, "Native timer Beta -> Gamma")
        check(view.preferredSize == initialSize, "Name rotation must not change window geometry")
        view.showPlatformStage(); check(!view.fixtureTimer, "Expanded stage pauses")
        wait(); view.collapseToStage1(); check(view.fixtureFrontID == C.id, "Expanded stage preserves task selection")
        C.phase = .done
        view.update(statuses: [codex], tasksByPlatform: [.codex: [A, B, C, done]])
        check(view.fixtureFrontID == A.id, "Completed task leaves rotation immediately")
        let D = TrayTaskItem(status: claude), E = TrayTaskItem(status: status(.claude, "Epsilon", 3))
        view.update(statuses: [claude, codex], tasksByPlatform: [.codex: [A, B, done], .claude: [D, E]])
        wait(); check(view.fixtureFrontID == D.id, "Next platform Delta")
        wait(); check(view.fixtureFrontID == B.id, "Returning platform Beta, not Alpha")
        reduceMotion = true; view.accessibilityDisplayOptionsDidChange()
        check(!view.fixtureTimer && view.fixtureFrontID == A.id, "Reduced preference freezes real view timer")
        wait(); check(view.fixtureFrontID == A.id, "Reduced preference keeps same task")
        reduceMotion = false; view.accessibilityDisplayOptionsDidChange()
        check(view.fixtureTimer, "Normal preference restores real timer")
        view.update(statuses: [codex], tasksByPlatform: [.codex: [A, done]])
        check(!view.fixtureTimer && view.fixtureFrontID == A.id, "Single remaining task stops timer")
        print("Native carousel verified: Alpha -> Beta -> Gamma; snapshot stability, dismiss ID, completion, expanded pause, multi-platform tasks, fixture motion preferences")
    }
}
`)
  run('swiftc', ['-parse-as-library', '-I', path.join(build, 'Modules'), source, ...objects, '-o', binary])
  console.log(run(binary, []))
} finally { fs.rmSync(temporary, { recursive: true, force: true }) }
