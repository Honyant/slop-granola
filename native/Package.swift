// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "granola-helper",
    platforms: [.macOS("14.2")],
    products: [
        .executable(name: "granola-helper", targets: ["granola-helper"]),
    ],
    targets: [
        .target(name: "CAtomics"),
        .target(name: "HelperCore", dependencies: ["CAtomics"]),
        .executableTarget(name: "granola-helper", dependencies: ["HelperCore"]),
        .testTarget(name: "HelperCoreTests", dependencies: ["HelperCore"]),
    ]
)
