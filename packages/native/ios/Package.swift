// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "PandaBridgeKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "PandaBridgeKit", targets: ["PandaBridgeKit"]),
    ],
    targets: [
        .target(name: "PandaBridgeKit"),
    ]
)
