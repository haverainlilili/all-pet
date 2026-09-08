// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "AllPet",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(name: "AllPetCore", targets: ["AllPetCore"]),
        .executable(name: "allpet", targets: ["allpet"])
    ],
    targets: [
        .target(
            name: "AllPetCore",
            resources: [.copy("Resources/BundledPets")]
        ),
        .executableTarget(name: "allpet", dependencies: ["AllPetCore"])
    ]
)
